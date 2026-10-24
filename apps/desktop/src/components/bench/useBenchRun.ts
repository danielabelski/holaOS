import type { BenchEvent, BenchRun, BenchSubject } from "@holaboss/remote-api/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { remoteApi } from "@/lib/remoteApiClient";

const POLL_MS = 200;
const STREAM_CHARS = 1600;
const TPS_WINDOW_MS = 1000;

export type BenchStepKind = "warmup" | "speed" | "task";

export interface BenchStep {
  id: string;
  kind: BenchStepKind;
  label: string;
  state: "pending" | "running" | "done";
  status?: string;
  passed?: number;
  samples?: number;
  decodeTps?: number;
  ttftMs?: number;
}

export const SUITE_PLAN: Record<string, Array<Pick<BenchStep, "id" | "kind" | "label">>> = {
  "suite-standard@1.0": [
    { id: "warmup", kind: "warmup", label: "Warm up" },
    { id: "speed@0", kind: "speed", label: "Speed · empty context" },
    { id: "speed@8k", kind: "speed", label: "Speed · 8K context" },
    { id: "code-intervals", kind: "task", label: "Code · unit tests" },
    { id: "tool-flight", kind: "task", label: "Tool calling" },
    { id: "needle-8k", kind: "task", label: "Long context · 8K needle" },
  ],
};

export interface BenchProgress {
  steps: BenchStep[];
  currentStep: string | null;
  stream: string;
  liveTps: number | null;
  pull: { status: string; completed?: number; total?: number } | null;
  cpuBusyPct: number | null;
  runStartedAt: number | null;
}

export function initialProgress(suite: string): BenchProgress {
  return {
    steps: (SUITE_PLAN[suite] ?? []).map((step) => ({ ...step, state: "pending" })),
    currentStep: null,
    stream: "",
    liveTps: null,
    pull: null,
    cpuBusyPct: null,
    runStartedAt: null,
  };
}

function updateStep(steps: BenchStep[], id: string, patch: Partial<BenchStep>): BenchStep[] {
  const known = steps.some((step) => step.id === id);
  const next = known ? steps : [...steps, { id, kind: "task" as const, label: id, state: "pending" as const }];
  return next.map((step) => (step.id === id ? { ...step, ...patch } : step));
}

/** Folds runtime events into what the run view shows. `recent` holds text-event token counts for the live rate. */
export function applyBenchEvents(
  progress: BenchProgress,
  events: BenchEvent[],
  recent: Array<{ at: number; n: number }>,
): BenchProgress {
  let next = progress;
  for (const event of events) {
    const task = typeof event.task === "string" ? event.task : null;
    switch (event.type) {
      case "run_started":
        next = { ...next, runStartedAt: event.at };
        break;
      case "machine_busy":
        next = { ...next, cpuBusyPct: typeof event.cpu_busy_pct === "number" ? event.cpu_busy_pct : null };
        break;
      case "pull_progress":
        next = {
          ...next,
          pull: {
            status: String(event.status ?? ""),
            completed: typeof event.completed === "number" ? event.completed : undefined,
            total: typeof event.total === "number" ? event.total : undefined,
          },
        };
        break;
      case "task_start":
        if (task) {
          recent.length = 0;
          next = { ...next, currentStep: task, stream: "", liveTps: null, steps: updateStep(next.steps, task, { state: "running" }) };
        }
        break;
      case "text":
        if (task && task === next.currentStep) {
          recent.push({ at: event.at, n: typeof event.n === "number" ? event.n : 1 });
          while (recent.length > 0 && event.at - recent[0].at > TPS_WINDOW_MS) {
            recent.shift();
          }
          const span = recent.length > 1 ? (recent[recent.length - 1].at - recent[0].at) / 1000 : 0;
          const tokens = recent.slice(1).reduce((sum, entry) => sum + entry.n, 0);
          next = {
            ...next,
            stream: (next.stream + String(event.delta ?? "")).slice(-STREAM_CHARS),
            liveTps: span > 0.3 ? tokens / span : next.liveTps,
          };
        }
        break;
      case "task_done":
        if (task) {
          next = {
            ...next,
            steps: updateStep(next.steps, task, {
              state: "done",
              status: typeof event.status === "string" ? event.status : "ok",
              passed: typeof event.passed === "number" ? event.passed : undefined,
              samples: typeof event.samples === "number" ? event.samples : undefined,
              decodeTps: typeof event.decode_tps === "number" ? event.decode_tps : undefined,
              ttftMs: typeof event.ttft_ms === "number" ? event.ttft_ms : undefined,
            }),
          };
        }
        break;
      default:
        break;
    }
  }
  return next;
}

export function useBenchRun(suite: string) {
  const [run, setRun] = useState<BenchRun | null>(null);
  const [progress, setProgress] = useState<BenchProgress>(() => initialProgress(suite));
  const [startError, setStartError] = useState<string | null>(null);
  const cursor = useRef(0);
  const recent = useRef<Array<{ at: number; n: number }>>([]);

  const follow = useCallback(
    (next: BenchRun) => {
      cursor.current = 0;
      recent.current = [];
      setProgress(initialProgress(next.suite || suite));
      setRun(next);
    },
    [suite],
  );

  useEffect(() => {
    let cancelled = false;
    void remoteApi.bench
      .current({})
      .then(({ run: current }) => {
        if (!cancelled && current) {
          follow(current);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [follow]);

  const runId = run?.run_id ?? null;
  const running = run?.status === "running";
  useEffect(() => {
    if (!runId || !running) {
      return;
    }
    let stopped = false;
    const tick = async () => {
      while (!stopped) {
        try {
          const { run: latest, events } = await remoteApi.bench.get({ run_id: runId, after: cursor.current });
          if (stopped) {
            return;
          }
          if (events.length > 0) {
            cursor.current = events[events.length - 1].seq;
            setProgress((current) => applyBenchEvents(current, events, recent.current));
          }
          setRun(latest);
          if (latest.status !== "running") {
            return;
          }
        } catch {
          // the runtime may be restarting; keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    };
    void tick();
    return () => {
      stopped = true;
    };
  }, [runId, running]);

  const start = useCallback(
    async (subject: BenchSubject, unloadUserModels = false) => {
      setStartError(null);
      try {
        follow(await remoteApi.bench.start({ subject, suite, unload_user_models: unloadUserModels }));
      } catch (error) {
        setStartError(error instanceof Error ? error.message : "Could not start the benchmark.");
      }
    },
    [follow, suite],
  );

  const cancel = useCallback(async () => {
    if (runId) {
      await remoteApi.bench.cancel({ run_id: runId }).catch(() => undefined);
    }
  }, [runId]);

  return { run, progress, startError, start, cancel };
}
