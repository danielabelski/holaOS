import {
  type RunRecordView,
  TASK_LABELS,
  engineLabel,
  formatMs,
  formatTps,
  hardwareLabel,
  speedResult,
  taskResults,
} from "./record";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function resultsCsv(record: RunRecordView): string {
  const header = ["task", "kind", "status", "passed", "samples", "decode_tps", "ttft_ms", "engine_decode_tps", "vram_bytes", "cpu_offload"];
  const rows = record.results.map((result) =>
    result.kind === "speed"
      ? [result.task, "speed", result.status, "", "", result.metrics.decode_tps, result.metrics.ttft_ms, result.metrics.engine_decode_tps, result.metrics.vram_bytes, result.metrics.cpu_offload]
      : [result.task, "task", result.status, result.passed, result.samples, "", "", "", "", ""],
  );
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function taskLine(record: RunRecordView): string {
  return taskResults(record)
    .map((task) => {
      const label = TASK_LABELS[task.task] ?? task.task;
      return task.status === "unsupported" ? `${label}: not supported on Ollama` : `${label}: ${task.passed}/${task.samples}`;
    })
    .join("; ");
}

function timestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A plain-data script a creator can read over the recording; every number comes from the Run Record. */
export function narrationScript(record: RunRecordView, url: string): string {
  const shallow = speedResult(record, "speed@0");
  const deep = speedResult(record, "speed@8k");
  const offload = shallow?.cpu_offload ? " Part of the model ran on the CPU, so it does not fully fit in GPU memory." : "";
  const lines = [
    `# ${record.subject.name} on ${hardwareLabel(record)}`,
    "",
    `${record.subject.name} (${record.subject.quant}) running locally on ${hardwareLabel(record)} with ${engineLabel(record)}.`,
    "",
    `- Decode speed: ${formatTps(shallow?.decode_tps)} tokens per second, first token in ${formatMs(shallow?.ttft_ms)}.`,
    `- With 8K tokens of context: ${formatTps(deep?.decode_tps)} tokens per second, first token in ${formatMs(deep?.ttft_ms)}.${offload}`,
    `- Capability check (3 tries each, graded by a program): ${taskLine(record)}.`,
    "",
    `Suite ${record.suite.id}@${record.suite.version}. Full results: ${url}`,
  ];
  const highlights = record.artifacts.highlights;
  if (highlights.length > 0) {
    lines.push("", "## Moments in the recording", "");
    for (const h of highlights) {
      const what = h.label === "first_token" ? "first token" : h.label === "error" ? "error" : "done";
      lines.push(`- ${timestamp(h.t)} ${h.task ?? ""} ${what}`.replace(/\s+/g, " ").trim());
    }
  }
  return `${lines.join("\n")}\n`;
}

export function shareText(record: RunRecordView): string {
  const shallow = speedResult(record, "speed@0");
  return `${record.subject.name} on my ${hardwareLabel(record)}: ${formatTps(shallow?.decode_tps)} tok/s, first token in ${formatMs(shallow?.ttft_ms)}. Measured with holaOS.`;
}

export function kitFileName(record: RunRecordView): string {
  return `${record.subject.id}-${record.started_at.slice(0, 10)}-holaos-kit.zip`;
}
