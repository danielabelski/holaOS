import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  nativeImage,
  session,
  shell,
} from "electron";
import JSZip from "jszip";
import {
  BENCH_CARD_SIZE,
  BENCH_WINDOW_SIZE,
  type BenchDeepLink,
  benchSubjectUrl,
  isBenchRunDir,
  isCardName,
  xIntentUrl,
} from "./bench-links";
import type { BenchKitFile, BenchWindowContext } from "../shared/bench-protocol";

const SUBJECT_FETCH_TIMEOUT_MS = 10_000;

export interface BenchWindowDeps {
  preloadPath: string;
  loadRenderer: (win: BrowserWindow, query: Record<string, string>) => Promise<void>;
  /** e.g. `<HolaHub>/bench/subjects`; empty disables deep links. */
  subjectsBaseUrl: () => string;
  /** e.g. `<HolaHub>/bench/runs`. */
  resultBaseUrl: () => string;
  /** `<sandbox>/workspace`, the parent of every workspace directory. */
  workspaceRoot: () => string;
  fetchImpl?: typeof fetch;
}

export function createBenchWindowController(deps: BenchWindowDeps) {
  let win: BrowserWindow | null = null;
  let context: BenchWindowContext | null = null;

  async function fetchSubject(link: BenchDeepLink): Promise<BenchWindowContext> {
    const base: BenchWindowContext = {
      subject: null,
      subject_id: link.subjectId,
      suite: link.suite,
      error: null,
      result_base_url: deps.resultBaseUrl(),
    };
    const subjectsBaseUrl = deps.subjectsBaseUrl();
    if (!subjectsBaseUrl) {
      return { ...base, error: "Model pages are not configured in this build." };
    }
    try {
      const response = await (deps.fetchImpl ?? fetch)(benchSubjectUrl(subjectsBaseUrl, link.subjectId), {
        signal: AbortSignal.timeout(SUBJECT_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ...base, error: `Could not load this model (${response.status}).` };
      }
      return { ...base, subject: (await response.json()) as Record<string, unknown> };
    } catch {
      return { ...base, error: "Could not load this model. Check your connection and open the link again." };
    }
  }

  async function open(link: BenchDeepLink): Promise<void> {
    context = await fetchSubject(link);
    if (win && !win.isDestroyed()) {
      win.webContents.send("bench:context", context);
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
      return;
    }
    const created = new BrowserWindow({
      ...BENCH_WINDOW_SIZE,
      useContentSize: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: "holaOS Benchmark",
      backgroundColor: "#0b0b0c",
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // The run view keeps streaming tokens and recording while another app is in front.
        backgroundThrottling: false,
      },
    });
    win = created;
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.once("ready-to-show", () => created.show());
    created.on("closed", () => {
      if (win === created) {
        win = null;
      }
    });
    await deps.loadRenderer(created, { view: "bench" });
  }

  function assertRunDir(runDir: string): string {
    if (!isBenchRunDir(deps.workspaceRoot(), runDir)) {
      throw new Error("Refusing to write outside a benchmark run directory.");
    }
    return path.resolve(runDir);
  }

  async function renderCard(runDir: string, name: string, html: string): Promise<{ file: string; dataUrl: string }> {
    const dir = assertRunDir(runDir);
    if (!isCardName(name)) {
      throw new Error("Invalid card name.");
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "holaos-card-"));
    const renderWindow = new BrowserWindow({
      ...BENCH_CARD_SIZE,
      useContentSize: true,
      show: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: true },
    });
    try {
      const htmlPath = path.join(tempDir, "card.html");
      await fs.writeFile(htmlPath, html, "utf8");
      await renderWindow.loadFile(htmlPath);
      await renderWindow.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
      let image = await renderWindow.webContents.capturePage();
      const size = image.getSize();
      if (size.width !== BENCH_CARD_SIZE.width || size.height !== BENCH_CARD_SIZE.height) {
        image = image.resize({ ...BENCH_CARD_SIZE, quality: "best" });
      }
      const file = path.join(dir, `${name}.png`);
      await fs.writeFile(file, image.toPNG());
      return { file, dataUrl: image.toDataURL() };
    } finally {
      renderWindow.destroy();
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function saveRecording(runDir: string, bytes: Uint8Array, extension: string): Promise<{ file: string }> {
    const dir = assertRunDir(runDir);
    const ext = extension === "webm" ? "webm" : "mp4";
    const file = path.join(dir, `recording.${ext}`);
    await fs.writeFile(file, bytes);
    return { file };
  }

  async function exportKit(runDir: string, suggestedName: string, files: BenchKitFile[]): Promise<{ path: string | null }> {
    const dir = assertRunDir(runDir);
    const zip = new JSZip();
    for (const entry of files) {
      const name = path.basename(entry.name);
      if (entry.text !== undefined) {
        zip.file(name, entry.text);
      } else if (entry.path) {
        const source = path.resolve(entry.path);
        if (path.dirname(source) !== dir) {
          throw new Error("Kit files must come from the run directory.");
        }
        zip.file(name, await fs.readFile(source));
      }
    }
    const result = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : (undefined as never), {
      title: "Export creator kit",
      defaultPath: path.join(os.homedir(), "Downloads", path.basename(suggestedName)),
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) {
      return { path: null };
    }
    await fs.writeFile(result.filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    return { path: result.filePath };
  }

  async function share(runDir: string, cardFile: string, text: string, url: string): Promise<void> {
    const dir = assertRunDir(runDir);
    const source = path.resolve(cardFile);
    if (path.dirname(source) !== dir) {
      throw new Error("Only a card from this run can be shared.");
    }
    clipboard.writeImage(nativeImage.createFromPath(source));
    await shell.openExternal(xIntentUrl(text, url));
  }

  function currentWindow(): BrowserWindow | null {
    return win && !win.isDestroyed() ? win : null;
  }

  function fromBenchWindow<Args extends unknown[], Result>(
    channel: string,
    handler: (...args: Args) => Result | Promise<Result>,
  ): void {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: Args) => {
      if (event.sender !== currentWindow()?.webContents) {
        throw new Error(`Unauthorized IPC sender for ${channel}.`);
      }
      return handler(...args);
    });
  }

  function register(): void {
    fromBenchWindow("bench:getContext", () => context);
    fromBenchWindow("bench:renderCard", (runDir: string, name: string, html: string) => renderCard(runDir, name, html));
    fromBenchWindow("bench:saveRecording", (runDir: string, bytes: Uint8Array, extension: string) =>
      saveRecording(runDir, bytes, extension),
    );
    fromBenchWindow("bench:exportKit", (runDir: string, suggestedName: string, files: BenchKitFile[]) =>
      exportKit(runDir, suggestedName, files),
    );
    fromBenchWindow("bench:share", (runDir: string, cardFile: string, text: string, url: string) =>
      share(runDir, cardFile, text, url),
    );
    // Tab capture of the bench window itself: no screen-recording permission and no picker.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const target = win && !win.isDestroyed() ? win.webContents.mainFrame : null;
      const frame = request.frame;
      if (target && frame && frame.processId === target.processId && frame.routingId === target.routingId) {
        callback({ video: frame });
        return;
      }
      callback({});
    });
  }

  return { open, register, window: currentWindow };
}
