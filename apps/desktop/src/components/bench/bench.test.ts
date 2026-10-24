import assert from "node:assert/strict";
import test from "node:test";

import type { BenchEvent } from "@holaboss/remote-api/contract";
import { benchmarkCardHtml, capabilityCardHtml } from "./cards";
import { kitFileName, narrationScript, resultsCsv, shareText } from "./kit";
import { type RunRecordView, hardwareLabel } from "./record";
import { preferredRecordingMime } from "./recording";
import { applyBenchEvents, initialProgress } from "./useBenchRun";

const record: RunRecordView = {
  run_id: "6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11",
  suite: { id: "suite-standard", version: "1.0" },
  subject: {
    id: "openbmb-minicpm5-2b",
    name: "MiniCPM5-2B",
    vendor: "OpenBMB",
    quant: "Q4_K_M",
    tag: "openbmb/minicpm5-2b:q4_K_M",
    version: "71a44e98",
    digest_registered: false,
  },
  runtime: { hardware: { cpu: "Apple M4 Max", memory_gb: 64 }, provider: { engine: "ollama", version: "0.40.10" } },
  results: [
    { task: "speed@0", kind: "speed", status: "ok", metrics: { depth: 0, decode_tps: 102.1, ttft_ms: 62, vram_bytes: 2_033_702_665, model_bytes: 2_033_702_665, cpu_offload: false } },
    { task: "speed@8k", kind: "speed", status: "ok", metrics: { depth: 8192, decode_tps: 85.4, ttft_ms: 3301.7 } },
    { task: "code-intervals", kind: "task", category: "code", status: "ok", passed: 3, samples: 3 },
    { task: "tool-flight", kind: "task", category: "tool", status: "unsupported", passed: 0, samples: 0 },
    { task: "needle-8k", kind: "task", category: "long_context", status: "ok", passed: 2, samples: 3 },
  ],
  artifacts: { highlights: [{ t: 3.4, label: "first_token", task: "speed@0" }, { t: 72.2, label: "task_done", task: "needle-8k" }] },
  started_at: "2026-10-24T06:40:05Z",
};
const url = "https://hub.holaos.ai/bench/runs/6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11";

test("the benchmark card leads with decode speed and shows the machine and link", () => {
  const html = benchmarkCardHtml(record, url);
  assert.match(html, />102<\/span>/);
  assert.match(html, /62 ms/);
  assert.match(html, /85\.4 tok\/s/);
  assert.match(html, /1\.9 GB/);
  assert.doesNotMatch(html, /Partly on CPU/);
  assert.match(html, /Apple M4 Max · 64 GB/);
  assert.match(html, /hub\.holaos\.ai\/bench\/runs\/6f1c2a9e/);
  assert.match(html, /Ollama 0\.40\.10/);
});

test("a model that spills to the CPU is labelled on the card", () => {
  const spilled = structuredClone(record);
  const speed = spilled.results[0];
  if (speed.kind === "speed") {
    speed.metrics.cpu_offload = true;
  }
  assert.match(benchmarkCardHtml(spilled, url), /Partly on CPU/);
});

test("the capability card shows x/3 and keeps unsupported apart from failed", () => {
  const html = capabilityCardHtml(record, url);
  assert.match(html, /Code · unit tests/);
  assert.match(html, />3\/3</);
  assert.match(html, />2\/3</);
  assert.match(html, /Not supported on Ollama/);
  assert.doesNotMatch(html, />0\/0</);
});

test("text from the model config is escaped in cards", () => {
  const hostile = structuredClone(record);
  hostile.subject.name = '<img src=x onerror="alert(1)">';
  const html = benchmarkCardHtml(hostile, url) + capabilityCardHtml(hostile, url);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("the kit carries a CSV, a data-only script and a dated name", () => {
  const csv = resultsCsv(record).trim().split("\n");
  assert.equal(csv[0], "task,kind,status,passed,samples,decode_tps,ttft_ms,engine_decode_tps,vram_bytes,cpu_offload");
  assert.equal(csv[1], "speed@0,speed,ok,,,102.1,62,,2033702665,false");
  assert.equal(csv[4], "tool-flight,task,unsupported,0,0,,,,,");
  const script = narrationScript(record, url);
  assert.match(script, /102 tokens per second, first token in 62 ms/);
  assert.match(script, /Tool calling: not supported on Ollama/);
  assert.match(script, /- 0:03 speed@0 first token/);
  assert.match(script, /- 1:12 needle-8k done/);
  assert.equal(kitFileName(record), "openbmb-minicpm5-2b-2026-10-24-holaos-kit.zip");
  assert.equal(shareText(record), "MiniCPM5-2B on my Apple M4 Max · 64 GB: 102 tok/s, first token in 62 ms. Measured with holaOS.");
});

test("a discrete GPU names the card, not the CPU", () => {
  const pc = structuredClone(record);
  pc.runtime.hardware = { cpu: "AMD Ryzen 9 7950X", memory_gb: 64, gpus: ["NVIDIA GeForce RTX 4090, 24564 MiB"] };
  assert.equal(hardwareLabel(pc), "RTX 4090 24 GB · 64 GB RAM");
});

test("runtime events fold into steps, a live rate and the token stream", () => {
  const recent: Array<{ at: number; n: number }> = [];
  const events: BenchEvent[] = [
    { seq: 1, at: 1000, type: "run_started" },
    { seq: 2, at: 1100, type: "machine_busy", cpu_busy_pct: 40 },
    { seq: 3, at: 1200, type: "pull_progress", status: "pulling", completed: 5, total: 10 },
    { seq: 4, at: 2000, type: "task_start", task: "speed@0", kind: "speed" },
    { seq: 5, at: 2100, type: "text", task: "speed@0", delta: "one, ", n: 10 },
    { seq: 6, at: 2600, type: "text", task: "speed@0", delta: "two, ", n: 50 },
    { seq: 7, at: 3000, type: "text", task: "speed@0", delta: "three", n: 40 },
    { seq: 8, at: 3100, type: "task_done", task: "speed@0", kind: "speed", decode_tps: 101.5, ttft_ms: 61 },
    { seq: 9, at: 3200, type: "task_start", task: "tool-flight", kind: "task" },
    { seq: 10, at: 3300, type: "task_done", task: "tool-flight", kind: "task", status: "unsupported" },
  ];
  const before = applyBenchEvents(initialProgress("suite-standard@1.0"), events.slice(0, 7), recent);
  assert.equal(before.runStartedAt, 1000);
  assert.equal(before.cpuBusyPct, 40);
  assert.deepEqual(before.pull, { status: "pulling", completed: 5, total: 10 });
  assert.equal(before.currentStep, "speed@0");
  assert.equal(before.stream, "one, two, three");
  assert.equal(Math.round(before.liveTps ?? 0), 100);
  const after = applyBenchEvents(before, events.slice(7), recent);
  const speed = after.steps.find((step) => step.id === "speed@0");
  assert.deepEqual([speed?.state, speed?.decodeTps, speed?.ttftMs], ["done", 101.5, 61]);
  assert.equal(after.steps.find((step) => step.id === "tool-flight")?.status, "unsupported");
  assert.equal(after.stream, "");
  assert.equal(after.steps.length, 6);
});

test("recording prefers H.264 MP4 and falls back to WebM", () => {
  assert.equal(preferredRecordingMime(() => true), "video/mp4;codecs=avc1.640028");
  assert.equal(preferredRecordingMime((mime) => mime.startsWith("video/webm")), "video/webm;codecs=vp9");
  assert.equal(preferredRecordingMime(() => false), null);
});
