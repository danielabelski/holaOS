import path from "node:path";

export const BENCH_DEEP_LINK_HOST = "bench";
export const BENCH_DEFAULT_SUITE = "suite-standard@1.0";
export const BENCH_WINDOW_SIZE = { width: 1280, height: 720 } as const;
export const BENCH_CARD_SIZE = { width: 1200, height: 675 } as const;

const SUBJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SUITE_PATTERN = /^[a-z0-9-]+@[0-9][0-9.]*$/;
const RUN_DIR_NAME_PATTERN = /^[0-9a-f-]{36}$/;
const CARD_NAME_PATTERN = /^[a-z0-9-]+$/;

export interface BenchDeepLink {
  subjectId: string;
  suite: string;
}

/** ai.holaboss.app://bench?subject=<radar id>[&suite=suite-standard@1.0] */
export function parseBenchDeepLink(url: URL | null): BenchDeepLink | null {
  if (!url || url.hostname !== BENCH_DEEP_LINK_HOST) {
    return null;
  }
  const subjectId = url.searchParams.get("subject")?.trim() ?? "";
  const suite = url.searchParams.get("suite")?.trim() || BENCH_DEFAULT_SUITE;
  if (!SUBJECT_ID_PATTERN.test(subjectId) || !SUITE_PATTERN.test(suite)) {
    return null;
  }
  return { subjectId, suite };
}

export function benchSubjectUrl(subjectsBaseUrl: string, subjectId: string): string {
  return `${subjectsBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(subjectId)}.json`;
}

/** Run directories are `<workspace>/bench/<uuid>`; anything else is refused. */
export function isBenchRunDir(workspaceRoot: string, runDir: string): boolean {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(runDir));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const parts = relative.split(path.sep);
  return parts.length === 3 && parts[1] === "bench" && RUN_DIR_NAME_PATTERN.test(parts[2]);
}

export function isCardName(name: string): boolean {
  return CARD_NAME_PATTERN.test(name);
}

export function xIntentUrl(text: string, url: string): string {
  const params = new URLSearchParams({ text, url });
  return `https://twitter.com/intent/tweet?${params.toString()}`;
}
