import {
  type RunRecordView,
  TASK_INFO,
  engineLabel,
  explainReason,
  formatMs,
  formatTps,
  hardwareLabel,
  readingComparison,
  speedResult,
  taskResults,
  topReason,
  wasBusy,
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

function taskSummary(record: RunRecordView): string {
  return taskResults(record)
    .map((task) => {
      const info = TASK_INFO[task.task];
      const name = info?.short ?? task.task;
      return task.status === "unsupported" ? `${name} n/a` : `${name} ${task.passed}/${task.samples}`;
    })
    .join(" · ");
}

function timestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function capabilityPost(record: RunRecordView): string {
  const lines = taskResults(record).map((task) => {
    const info = TASK_INFO[task.task];
    const title = info?.title ?? task.task;
    if (task.status === "unsupported") {
      return `${title}: not supported by this Ollama build`;
    }
    const reason = task.passed < task.samples ? topReason(task) : null;
    return `${title}: ${task.passed}/${task.samples}${reason ? ` (${explainReason(reason)})` : ""}`;
  });
  return `Capability, 3 tries each, graded by code:\n${lines.join("\n")}`;
}

/** Ready-to-post copy for a creator; every number comes from the Run Record. */
export function narrationScript(record: RunRecordView, url: string): string {
  const shallow = speedResult(record, "speed@0");
  const deep = speedResult(record, "speed@8k");
  const reading = readingComparison(shallow?.decode_tps);
  const hardware = hardwareLabel(record);
  const busy = wasBusy(record);
  const lines = [
    `# ${record.subject.name} on ${hardware}`,
    "",
  ];
  if (busy !== null) {
    lines.push(`> Other apps used ${busy}% of the CPU during this run, so speed is likely low. Run again on an idle machine before posting.`, "");
  }
  lines.push(
    "## Post",
    "",
    shareText(record),
    url,
    "",
    "## Thread",
    "",
    `1/ ${record.subject.name} (${record.subject.quant}) running locally on ${hardware} with ${engineLabel(record)}: ${formatTps(shallow?.decode_tps)} tokens a second, first token in ${formatMs(shallow?.ttft_ms)}.${reading ? ` That is about ${Math.round(reading.wordsPerSecond)} words a second.` : ""}`,
    "",
    `2/ With 8K tokens already in the context it still does ${formatTps(deep?.decode_tps)} tok/s, and the first token arrives in ${formatMs(deep?.ttft_ms)}.${shallow?.cpu_offload ? " Part of the model ran on the CPU because it did not fit in GPU memory." : ""}`,
    "",
    `3/ ${capabilityPost(record)}`,
    "",
    `4/ Same suite (${record.suite.id}@${record.suite.version}) on any machine, so results compare like for like. Full run record: ${url}`,
  );
  const highlights = record.artifacts.highlights;
  if (highlights.length > 0) {
    lines.push("", "## Voice-over", "");
    for (const h of highlights) {
      const name = TASK_INFO[h.task ?? ""]?.title ?? (h.task === "speed@0" ? "Speed" : h.task === "speed@8k" ? "Speed at 8K" : h.task ?? "");
      const what = h.label === "first_token" ? "starts" : h.label === "error" ? "hits an error" : "done";
      lines.push(`- ${timestamp(h.t)} ${name} ${what}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function shareText(record: RunRecordView): string {
  const shallow = speedResult(record, "speed@0");
  const deep = speedResult(record, "speed@8k");
  return `${record.subject.name} on my ${hardwareLabel(record)}: ${formatTps(shallow?.decode_tps)} tok/s, first token in ${formatMs(shallow?.ttft_ms)}, ${formatTps(deep?.decode_tps)} tok/s with 8K of context. ${taskSummary(record)}. Measured locally with holaOS.`;
}

export function kitFileName(record: RunRecordView): string {
  return `${record.subject.id}-${record.started_at.slice(0, 10)}-holaos-kit.zip`;
}
