import {
  type RunRecordView,
  TASK_LABELS,
  engineLabel,
  formatGb,
  formatMs,
  formatTps,
  hardwareLabel,
  speedResult,
  taskResults,
} from "./record";

/** Cards are rendered offscreen at 1200×675 from these self-contained documents. */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1200px; height: 675px; overflow: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif;
    background: #0b0b0c; color: #f4f4f5; -webkit-font-smoothing: antialiased;
    padding: 56px 64px; display: flex; flex-direction: column;
  }
  .eyebrow { display: flex; justify-content: space-between; align-items: center; color: #a1a1aa; font-size: 20px; letter-spacing: 0.02em; }
  .brand { color: #f4f4f5; font-weight: 600; }
  .model { margin-top: 28px; font-size: 52px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.05; }
  .meta { margin-top: 10px; color: #a1a1aa; font-size: 22px; }
  .footer { margin-top: auto; display: flex; justify-content: space-between; color: #71717a; font-size: 18px; border-top: 1px solid #27272a; padding-top: 20px; }
  .num { font-variant-numeric: tabular-nums; }
`;

function shell(title: string, css: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;
}

function header(record: RunRecordView, label: string): string {
  return `<div class="eyebrow"><span><span class="brand">holaOS</span> · ${escapeHtml(label)}</span><span class="num">${escapeHtml(`${record.suite.id}@${record.suite.version}`)}</span></div>
  <div class="model">${escapeHtml(record.subject.name)}</div>
  <div class="meta">${escapeHtml([record.subject.vendor, record.subject.quant, engineLabel(record)].filter(Boolean).join(" · "))}</div>`;
}

function footer(record: RunRecordView, url: string): string {
  const date = record.started_at.slice(0, 10);
  return `<div class="footer"><span>${escapeHtml(hardwareLabel(record))}</span><span class="num">${escapeHtml(url.replace(/^https?:\/\//, ""))} · ${escapeHtml(date)}</span></div>`;
}

export function benchmarkCardHtml(record: RunRecordView, url: string): string {
  const shallow = speedResult(record, "speed@0");
  const deep = speedResult(record, "speed@8k");
  const offload = shallow?.cpu_offload || deep?.cpu_offload;
  const css = `
    .hero { margin-top: 44px; display: flex; align-items: baseline; gap: 18px; }
    .hero .value { font-size: 148px; font-weight: 700; letter-spacing: -0.04em; line-height: 0.9; }
    .hero .unit { font-size: 30px; color: #a1a1aa; }
    .stats { margin-top: 40px; display: flex; gap: 56px; }
    .stat .label { color: #a1a1aa; font-size: 18px; }
    .stat .value { margin-top: 6px; font-size: 34px; font-weight: 600; }
    .flag { display: inline-block; margin-left: 10px; padding: 2px 10px; border: 1px solid #a16207; color: #facc15; border-radius: 999px; font-size: 16px; vertical-align: middle; }
  `;
  const body = `${header(record, "Benchmark")}
  <div class="hero"><span class="value num">${escapeHtml(formatTps(shallow?.decode_tps))}</span><span class="unit">tokens / second</span></div>
  <div class="stats">
    <div class="stat"><div class="label">First token</div><div class="value num">${escapeHtml(formatMs(shallow?.ttft_ms))}</div></div>
    <div class="stat"><div class="label">At 8K context</div><div class="value num">${escapeHtml(formatTps(deep?.decode_tps))} tok/s</div></div>
    <div class="stat"><div class="label">Memory</div><div class="value num">${escapeHtml(formatGb(shallow?.vram_bytes))}${offload ? '<span class="flag">Partly on CPU</span>' : ""}</div></div>
  </div>
  ${footer(record, url)}`;
  return shell(`${record.subject.name} benchmark`, css, body);
}

function dots(passed: number, samples: number): string {
  return Array.from({ length: samples }, (_, index) => `<span class="dot${index < passed ? " on" : ""}"></span>`).join("");
}

export function capabilityCardHtml(record: RunRecordView, url: string): string {
  const css = `
    .rows { margin-top: 40px; display: flex; flex-direction: column; }
    .row { display: flex; align-items: center; justify-content: space-between; padding: 22px 0; border-top: 1px solid #27272a; }
    .row:first-child { border-top: 0; }
    .row .name { font-size: 30px; font-weight: 550; }
    .row .score { display: flex; align-items: center; gap: 18px; font-size: 32px; font-weight: 600; }
    .dot { display: inline-block; width: 18px; height: 18px; border-radius: 999px; border: 2px solid #52525b; margin-left: 6px; }
    .dot.on { background: #22c55e; border-color: #22c55e; }
    .unsupported { color: #a1a1aa; font-size: 24px; font-weight: 500; }
    .note { margin-top: 14px; color: #71717a; font-size: 18px; }
  `;
  const rows = taskResults(record)
    .map((task) => {
      const name = TASK_LABELS[task.task] ?? task.task;
      const score =
        task.status === "unsupported"
          ? '<span class="unsupported">Not supported on Ollama</span>'
          : task.status === "error"
            ? '<span class="unsupported">Did not run</span>'
            : `<span class="num">${task.passed}/${task.samples}</span><span>${dots(task.passed, task.samples)}</span>`;
      return `<div class="row"><span class="name">${escapeHtml(name)}</span><span class="score">${score}</span></div>`;
    })
    .join("");
  const body = `${header(record, "Capability check")}
  <div class="rows">${rows}</div>
  <div class="note">Each task runs 3 times with the vendor's recommended sampling and is graded by a program.</div>
  ${footer(record, url)}`;
  return shell(`${record.subject.name} capability check`, css, body);
}
