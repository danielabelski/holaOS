/** Bench window IPC payloads shared by main, preload and renderer. */

export interface BenchWindowContext {
  subject: Record<string, unknown> | null;
  subject_id: string;
  suite: string;
  error: string | null;
  /** Public result page for a run: `<result_base_url>/<run_id>`. */
  result_base_url: string;
}

export interface BenchKitFile {
  name: string;
  /** Exactly one of `path` (a file in the run directory) or `text`. */
  path?: string;
  text?: string;
}
