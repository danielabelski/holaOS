/** Typed reads over a Run Record (hola.run-record/0.1); the runtime owns the schema. */

export interface SpeedMetrics {
  depth: number;
  decode_tps?: number;
  ttft_ms?: number;
  engine_decode_tps?: number;
  engine_prefill_tps?: number;
  vram_bytes?: number | null;
  model_bytes?: number | null;
  cpu_offload?: boolean | null;
}

export interface SpeedResult {
  task: string;
  kind: "speed";
  status: string;
  metrics: SpeedMetrics;
}

export interface TaskResult {
  task: string;
  kind: "task";
  category: string;
  status: "ok" | "unsupported" | "error";
  passed: number;
  samples: number;
  reasons?: Record<string, number>;
}

export interface RunRecordView {
  run_id: string;
  suite: { id: string; version: string };
  subject: { id: string; name: string; vendor: string | null; quant: string; tag: string; version: string | null; digest_registered: boolean };
  runtime: {
    hardware: { cpu?: string; memory_gb?: number; gpus?: string[]; model?: string };
    provider: { engine: string; version: string | null };
  };
  results: Array<SpeedResult | TaskResult>;
  artifacts: { highlights: Array<{ t: number; label: string; task?: string }> };
  started_at: string;
}

export const TASK_LABELS: Record<string, string> = {
  "code-intervals": "Code · unit tests",
  "tool-flight": "Tool calling",
  "needle-8k": "Long context · 8K needle",
};

export function speedResult(record: RunRecordView, task: string): SpeedMetrics | null {
  const result = record.results.find((entry) => entry.task === task && entry.kind === "speed");
  return result && result.kind === "speed" && result.status === "ok" ? result.metrics : null;
}

export function taskResults(record: RunRecordView): TaskResult[] {
  return record.results.filter((entry): entry is TaskResult => entry.kind === "task");
}

/** The machine as people say it: "Apple M5 Pro · 48 GB" or "RTX 4090 24 GB · 64 GB RAM". */
export function hardwareLabel(record: RunRecordView): string {
  const hw = record.runtime.hardware;
  const gpu = hw.gpus?.[0]
    ?.replace(/^NVIDIA\s+(GeForce\s+)?/i, "")
    .replace(/,\s*(\d+)\s*MiB$/i, (_match, mib: string) => ` ${Math.round(Number(mib) / 1024)} GB`)
    .replace(/,\s*/g, " ");
  const memory = hw.memory_gb ? `${hw.memory_gb} GB` : "";
  if (gpu) {
    return [gpu, memory ? `${memory} RAM` : ""].filter(Boolean).join(" · ");
  }
  return [hw.cpu ?? "Unknown machine", memory].filter(Boolean).join(" · ");
}

export function engineLabel(record: RunRecordView): string {
  const { engine, version } = record.runtime.provider;
  const name = engine === "ollama" ? "Ollama" : engine;
  return version ? `${name} ${version}` : name;
}

export function formatTps(value: number | undefined): string {
  return value === undefined ? "–" : value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

export function formatMs(value: number | undefined): string {
  if (value === undefined) {
    return "–";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

export function formatGb(bytes: number | null | undefined): string {
  return bytes ? `${(bytes / 2 ** 30).toFixed(1)} GB` : "–";
}

export function resultUrl(baseUrl: string, runId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${runId}`;
}
