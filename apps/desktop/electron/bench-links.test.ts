import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  benchSubjectUrl,
  isBenchRunDir,
  isCardName,
  parseBenchDeepLink,
  xIntentUrl,
} from "./bench-links.js";

const link = (value: string) => parseBenchDeepLink(new URL(value));

test("bench deep links carry a Radar subject id and default to the standard suite", () => {
  assert.deepEqual(link("ai.holaboss.app://bench?subject=openbmb-minicpm5-2b"), {
    subjectId: "openbmb-minicpm5-2b",
    suite: "suite-standard@1.0",
  });
  assert.deepEqual(link("ai.holaboss.app://bench?subject=qwen3-8b&suite=suite-standard@1.0"), {
    subjectId: "qwen3-8b",
    suite: "suite-standard@1.0",
  });
});

test("anything that is not a clean subject id or suite is ignored", () => {
  assert.equal(link("ai.holaboss.app://open-app?appId=x"), null);
  assert.equal(link("ai.holaboss.app://bench"), null);
  assert.equal(link("ai.holaboss.app://bench?subject=../../etc/passwd"), null);
  assert.equal(link("ai.holaboss.app://bench?subject=https://evil.example/x"), null);
  assert.equal(link("ai.holaboss.app://bench?subject=ok&suite=../x"), null);
  assert.equal(parseBenchDeepLink(null), null);
});

test("subject JSON lives under the configured base", () => {
  assert.equal(
    benchSubjectUrl("https://hub.holaos.ai/bench/subjects/", "openbmb-minicpm5-2b"),
    "https://hub.holaos.ai/bench/subjects/openbmb-minicpm5-2b.json",
  );
});

test("files are only written into <workspace>/bench/<run uuid>", () => {
  const root = path.join(path.sep, "sandbox", "workspace");
  const run = path.join(root, "ws-1", "bench", "6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11");
  assert.equal(isBenchRunDir(root, run), true);
  assert.equal(isBenchRunDir(root, path.join(root, "ws-1", "evals", "6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11")), false);
  assert.equal(isBenchRunDir(root, path.join(root, "ws-1", "bench", "x")), false);
  assert.equal(isBenchRunDir(root, path.join(run, "..", "..", "..", "..", "etc")), false);
  assert.equal(isBenchRunDir(root, path.join(path.sep, "tmp", "ws-1", "bench", "6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11")), false);
});

test("card names and share links", () => {
  assert.equal(isCardName("benchmark-card"), true);
  assert.equal(isCardName("../card"), false);
  const url = new URL(xIntentUrl("MiniCPM5-2B: 102 tok/s", "https://hub.holaos.ai/bench/runs/1"));
  assert.equal(url.searchParams.get("text"), "MiniCPM5-2B: 102 tok/s");
  assert.equal(url.searchParams.get("url"), "https://hub.holaos.ai/bench/runs/1");
});
