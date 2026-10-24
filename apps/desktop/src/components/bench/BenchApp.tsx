import type { BenchRun, BenchSubject } from "@holaboss/remote-api/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Download, ExternalLink, Loader2, Play, RotateCw, Square, TriangleAlert, Upload, X } from "@/components/ui/icons";
import { remoteApi } from "@/lib/remoteApiClient";
import { cn } from "@/lib/utils";
import type { BenchWindowContext } from "../../../shared/bench-protocol";
import { benchmarkCardHtml, capabilityCardHtml } from "./cards";
import { kitFileName, narrationScript, resultsCsv, shareText } from "./kit";
import {
  type RunRecordView,
  engineLabel,
  formatGb,
  formatTps,
  hardwareLabel,
  resultUrl,
  speedResult,
} from "./record";
import { type BenchRecording, startBenchRecording } from "./recording";
import { type BenchProgress, type BenchStep, useBenchRun } from "./useBenchRun";

const BENCH_THEME = "holaos-dark";
const FINAL_FRAME_MS = 1500;

interface FinishedRun {
  record: RunRecordView;
  url: string;
  cards: Array<{ name: string; file: string; dataUrl: string }>;
  recordingFile: string | null;
}

function subjectFrom(context: BenchWindowContext | null): BenchSubject | null {
  return (context?.subject as BenchSubject | null | undefined) ?? null;
}

function StepRow({ step, current }: { step: BenchStep; current: boolean }) {
  const score =
    step.kind === "speed" && step.decodeTps !== undefined
      ? `${formatTps(step.decodeTps)} tok/s`
      : step.kind === "task" && step.status === "unsupported"
        ? "Not supported"
        : step.kind === "task" && step.samples !== undefined
          ? `${step.passed ?? 0}/${step.samples}`
          : "";
  return (
    <li className={cn("flex items-center gap-3 rounded-lg px-3 py-2", current && "bg-fg-2")}>
      <span className="flex size-4 items-center justify-center">
        {step.state === "running" ? (
          <Loader2 className="size-3.5 animate-spin text-foreground" />
        ) : step.state === "done" ? (
          <Check className="size-3.5 text-success" />
        ) : (
          <span className="size-1.5 rounded-full bg-muted-foreground/50" />
        )}
      </span>
      <span className={cn("flex-1 truncate text-sm", step.state === "pending" ? "text-muted-foreground" : "text-foreground")}>
        {step.label}
      </span>
      <span className="font-medium text-foreground text-sm tabular-nums">{score}</span>
    </li>
  );
}

function PullBar({ pull }: { pull: NonNullable<BenchProgress["pull"]> }) {
  const pct = pull.total ? Math.min(100, ((pull.completed ?? 0) / pull.total) * 100) : 0;
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-fg-2">
        <div className="h-full rounded-full bg-foreground transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-muted-foreground text-xs tabular-nums">
        {pull.total ? `${formatGb(pull.completed ?? 0)} of ${formatGb(pull.total)}` : pull.status}
      </span>
    </div>
  );
}

function CenterLive({ run, progress }: { run: BenchRun; progress: BenchProgress }) {
  const step = progress.steps.find((entry) => entry.id === progress.currentStep);
  if (run.phase === "pulling" && progress.pull) {
    return (
      <div className="flex w-full flex-col items-center gap-4">
        <span className="text-muted-foreground text-sm">Downloading the model</span>
        <PullBar pull={progress.pull} />
      </div>
    );
  }
  if (run.phase !== "running" || !step) {
    const label = run.phase === "starting" ? "Starting Ollama" : run.phase === "finishing" ? "Writing results" : "Checking your machine";
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin" />
        {label}
      </div>
    );
  }
  return (
    <div className="flex w-full min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col items-center gap-1">
        <span className="text-muted-foreground text-xs uppercase tracking-wide">{step.label}</span>
        {step.kind === "task" ? (
          <span className="font-semibold text-5xl text-foreground tabular-nums">
            {step.state === "done" ? `${step.passed ?? 0}/${step.samples ?? 3}` : "Grading"}
          </span>
        ) : progress.liveTps === null ? (
          <span className="flex h-[72px] items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin" />
            Reading the prompt
          </span>
        ) : (
          <span className="flex items-baseline gap-2">
            <span className="font-semibold text-7xl text-foreground tabular-nums tracking-tight">
              {progress.liveTps.toFixed(0)}
            </span>
            <span className="text-muted-foreground text-sm">tok/s</span>
          </span>
        )}
      </div>
      <pre className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words rounded-xl border border-border bg-card p-3 font-mono text-[11px] text-muted-foreground leading-4">
        {progress.stream}
      </pre>
    </div>
  );
}

function RunError({
  run,
  onRetry,
  onUnloadAndRun,
}: {
  run: BenchRun;
  onRetry: () => void;
  onUnloadAndRun: () => void;
}) {
  const error = run.error;
  const models = Array.isArray(error?.details?.models)
    ? (error?.details?.models as Array<{ name?: string }>).map((model) => model.name).filter(Boolean)
    : [];
  const downloadUrl = typeof error?.details?.download_url === "string" ? error.details.download_url : null;
  return (
    <div className="flex w-full flex-col items-center gap-4 text-center">
      <TriangleAlert className="size-6 text-warning" />
      <p className="text-foreground text-sm">{error?.message ?? "The benchmark stopped."}</p>
      {models.length > 0 ? <p className="text-muted-foreground text-xs">{models.join(", ")}</p> : null}
      <div className="flex gap-2">
        {error?.code === "ollama_missing" && downloadUrl ? (
          <Button onClick={() => void window.electronAPI.ui.openExternalUrl(downloadUrl)} size="sm" type="button">
            <ExternalLink className="size-3.5" />
            Download Ollama
          </Button>
        ) : null}
        {error?.code === "user_models_loaded" ? (
          <Button onClick={onUnloadAndRun} size="sm" type="button">
            <Play className="size-3.5" />
            Unload them and run
          </Button>
        ) : (
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            <RotateCw className="size-3.5" />
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

function FinishedPanel({ finished, runDir }: { finished: FinishedRun; runDir: string }) {
  const [busy, setBusy] = useState<"kit" | "share" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const exportKit = async () => {
    setBusy("kit");
    setNote(null);
    try {
      const { record } = finished;
      const files = [
        ...finished.cards.map((card) => ({ name: `${card.name}.png`, path: card.file })),
        ...(finished.recordingFile ? [{ name: finished.recordingFile.split(/[\\/]/).pop() ?? "recording.mp4", path: finished.recordingFile }] : []),
        { name: "run-record.json", text: `${JSON.stringify(record, null, 2)}\n` },
        { name: "results.csv", text: resultsCsv(record) },
        { name: "highlights.json", text: `${JSON.stringify(record.artifacts.highlights, null, 2)}\n` },
        { name: "script.md", text: narrationScript(record, finished.url) },
      ];
      const { path } = await window.electronAPI.bench.exportKit(runDir, kitFileName(record), files);
      setNote(path ? `Saved ${path.split(/[\\/]/).pop()}` : null);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not export the kit.");
    } finally {
      setBusy(null);
    }
  };
  const share = async () => {
    const card = finished.cards[0];
    if (!card) {
      return;
    }
    setBusy("share");
    try {
      await window.electronAPI.bench.share(runDir, card.file, shareText(finished.record), finished.url);
      setNote("Card copied. Paste it into your post.");
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not share.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex w-full flex-col gap-3">
      {finished.cards.map((card) => (
        <img alt={card.name} className="w-full rounded-lg border border-border" key={card.name} src={card.dataUrl} />
      ))}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy !== null} onClick={() => void exportKit()} size="sm" type="button">
          {busy === "kit" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          Export creator kit
        </Button>
        <Button disabled={busy !== null} onClick={() => void share()} size="sm" type="button" variant="outline">
          {busy === "share" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          Share on X
        </Button>
      </div>
      {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
    </div>
  );
}

export function BenchApp() {
  const [context, setContext] = useState<BenchWindowContext | null>(null);
  const [loaded, setLoaded] = useState(false);
  const suite = context?.suite ?? "suite-standard@1.0";
  const { run, progress, startError, start, cancel } = useBenchRun(suite);
  const recording = useRef<BenchRecording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const runStatus = useRef<string | null>(null);
  runStatus.current = run?.status ?? null;
  const finalizedRun = useRef<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [finished, setFinished] = useState<FinishedRun | null>(null);
  const [finishing, setFinishing] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = BENCH_THEME;
    document.title = "holaOS Benchmark";
    void window.electronAPI.bench.getContext().then((initial) => {
      setContext(initial);
      setLoaded(true);
    });
    return window.electronAPI.bench.onContext(setContext);
  }, []);

  useEffect(() => {
    if (run?.status !== "running" || recording.current) {
      return;
    }
    setFinished(null);
    setRecordingError(null);
    void startBenchRecording()
      .then((started) => {
        if (runStatus.current !== "running") {
          void started.stop();
          return;
        }
        recording.current = started;
        setIsRecording(true);
      })
      .catch((error: unknown) => {
        setRecordingError(error instanceof Error ? error.message : "Recording is not available.");
      });
  }, [run?.status]);

  const finalize = useCallback(
    async (done: BenchRun) => {
      const active = recording.current;
      recording.current = null;
      setIsRecording(false);
      if (done.status !== "done") {
        await active?.stop().catch(() => undefined);
        return;
      }
      const url = resultUrl(context?.result_base_url ?? "", done.run_id);
      let recordingFile: string | null = null;
      try {
        if (active) {
          setFinishing("Saving the recording");
          await new Promise((resolve) => setTimeout(resolve, FINAL_FRAME_MS));
          const { bytes, extension } = await active.stop();
          recordingFile = (await window.electronAPI.bench.saveRecording(done.run_dir, bytes, extension)).file;
        }
        setFinishing("Making the cards");
        const { record } = await remoteApi.bench.record({ run_id: done.run_id });
        const view = record as unknown as RunRecordView;
        const cards = [];
        for (const [name, html] of [
          ["benchmark-card", benchmarkCardHtml(view, url)],
          ["capability-card", capabilityCardHtml(view, url)],
        ] as const) {
          cards.push({ name, ...(await window.electronAPI.bench.renderCard(done.run_dir, name, html)) });
        }
        const offset = active && progress.runStartedAt ? Math.max(0, (active.startedAt - progress.runStartedAt) / 1000) : 0;
        const { record: final } = await remoteApi.bench.setArtifacts({
          run_id: done.run_id,
          recording: recordingFile ? { file: recordingFile, scored_run: true } : null,
          cards: cards.map((card) => card.file),
          recording_offset_s: offset,
        });
        setFinished({ record: final as unknown as RunRecordView, url, cards, recordingFile });
      } catch (error) {
        setRecordingError(error instanceof Error ? error.message : "Could not finish the results.");
      } finally {
        setFinishing(null);
      }
    },
    [context?.result_base_url, progress.runStartedAt],
  );

  useEffect(() => {
    if (run && run.status !== "running" && finalizedRun.current !== run.run_id) {
      finalizedRun.current = run.run_id;
      void finalize(run);
    }
  }, [run, finalize]);

  const subject = subjectFrom(context);
  const isRunning = run?.status === "running";
  const record = finished?.record ?? null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-border border-b px-5">
        <span className="font-semibold text-sm">holaOS</span>
        <span className="text-muted-foreground text-sm">Benchmark</span>
        <span className="font-mono text-muted-foreground text-xs">{suite}</span>
        <div className="flex-1" />
        {isRunning && isRecording ? (
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="size-2 animate-pulse rounded-full bg-destructive" />
            Recording
          </span>
        ) : null}
        {isRunning ? (
          <Button onClick={() => void cancel()} size="xs" type="button" variant="ghost">
            <Square className="size-3" />
            Stop
          </Button>
        ) : null}
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[1fr_405px_1fr]">
        <section className="flex min-h-0 flex-col gap-3 border-border border-r p-4">
          <span className="px-3 text-muted-foreground text-xs uppercase tracking-wide">Suite</span>
          <ul className="flex flex-col gap-0.5">
            {progress.steps.map((step) => (
              <StepRow current={step.id === progress.currentStep && isRunning} key={step.id} step={step} />
            ))}
          </ul>
          {progress.cpuBusyPct !== null ? (
            <p className="mx-3 mt-auto rounded-lg border border-warning/40 p-2 text-warning text-xs">
              Other apps were using {progress.cpuBusyPct}% of the CPU when this run started. Numbers may be lower than usual.
            </p>
          ) : null}
        </section>

        <section className="flex min-h-0 flex-col items-center gap-5 px-6 py-6">
          {!loaded ? (
            <Loader2 className="mt-24 size-5 animate-spin text-muted-foreground" />
          ) : context?.error || !subject ? (
            <div className="mt-24 flex flex-col items-center gap-3 text-center">
              <X className="size-6 text-muted-foreground" />
              <p className="text-sm">{context?.error ?? "Open a model page and choose Run on my machine."}</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-center gap-1 text-center">
                <h1 className="font-semibold text-3xl tracking-tight">{subject.name}</h1>
                <span className="text-muted-foreground text-sm">
                  {[subject.vendor, subject.quant, "Ollama"].filter(Boolean).join(" · ")}
                </span>
              </div>
              {run && isRunning ? (
                <CenterLive progress={progress} run={run} />
              ) : run?.status === "failed" ? (
                <RunError onRetry={() => void start(subject)} onUnloadAndRun={() => void start(subject, true)} run={run} />
              ) : finishing ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="size-4 animate-spin" />
                  {finishing}
                </div>
              ) : record ? (
                <div className="flex flex-col items-center gap-1">
                  <span className="font-semibold text-7xl tabular-nums tracking-tight">
                    {formatTps(speedResult(record, "speed@0")?.decode_tps)}
                  </span>
                  <span className="text-muted-foreground text-sm">tokens / second</span>
                </div>
              ) : (
                <div className="mt-10 flex flex-col items-center gap-3">
                  <Button onClick={() => void start(subject)} size="lg" type="button">
                    <Play className="size-4" />
                    Run on this machine
                  </Button>
                  <span className="max-w-[300px] text-center text-muted-foreground text-xs">
                    About 3 minutes after the download. The window is recorded while it runs.
                  </span>
                  {startError ? <span className="text-destructive text-xs">{startError}</span> : null}
                </div>
              )}
              {recordingError ? <p className="text-muted-foreground text-xs">{recordingError}</p> : null}
            </>
          )}
        </section>

        <section className="flex min-h-0 flex-col gap-4 overflow-y-auto border-border border-l p-4">
          {record ? (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs uppercase tracking-wide">Machine</span>
                <span className="text-sm">{hardwareLabel(record)}</span>
                <span className="text-muted-foreground text-xs">{engineLabel(record)}</span>
              </div>
              {finished && run ? <FinishedPanel finished={finished} runDir={run.run_dir} /> : null}
            </>
          ) : (
            <div className="flex flex-col gap-2 text-muted-foreground text-xs leading-5">
              <span className="uppercase tracking-wide">What this measures</span>
              <span>Decode speed and time to first token with an empty and an 8K context, plus three tasks graded by a program: code with unit tests, tool calling and finding a fact in 8K tokens.</span>
              <span>Results show your machine and Ollama version so anyone can compare like with like.</span>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
