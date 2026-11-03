import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { findChromium, loadPlaywright, WEBGL_ARGS, WEBGPU_ARGS } from "./browser.js";
import { blankness, diff } from "./diff.js";
import { decodePng, encodePng } from "./png.js";
import { serveStatic } from "./server.js";

export interface CheckOptions {
  /** Folder with the page, or an http(s) URL of a running dev server. */
  target: string;
  /** HTML file inside the folder. Default index.html. */
  entry?: string;
  /** Folder the static server serves, when the page needs files above its own folder (for example ../node_modules). Default: the target folder. */
  root?: string;
  width?: number;
  height?: number;
  /** Milliseconds to let the scene run before the screenshot. Default 2000. */
  wait?: number;
  /** Also try WebGPU (best effort). */
  webgpu?: boolean;
  /** Baseline name; compares to .threesmith/baselines/<name>.png. */
  baseline?: string;
  updateBaseline?: boolean;
  /** Share of changed pixels that fails the baseline. Default 0.005. */
  tolerance?: number;
  /** Per-channel threshold for "changed". Default 16. */
  threshold?: number;
  /** Where baselines and diffs live. Default <folder>/.threesmith. */
  stateDir?: string;
  /** Console warnings that are not a problem. Substring match. */
  ignore?: string[];
}

export type IssueKind =
  | "page-error"
  | "console-error"
  | "console-warn"
  | "request-failed"
  | "no-canvas"
  | "no-webgl"
  | "context-lost"
  | "blank"
  | "no-frames"
  | "baseline-diff"
  | "baseline-size"
  | "baseline-missing"
  | "load-failed";

export interface Issue {
  kind: IssueKind;
  severity: "error" | "warn";
  message: string;
}

export interface CheckResult {
  ok: boolean;
  url: string;
  issues: Issue[];
  stats: {
    canvases: number;
    contexts: string[];
    frames: number;
    threeRevision: string | null;
    dominantColor: number;
    webgpuAdapter: boolean | null;
  };
  screenshot?: string;
  baseline?: { name: string; status: "created" | "updated" | "match" | "diff" | "size" | "missing"; ratio?: number; diffImage?: string };
}

const INIT = `(() => {
  const w = window;
  w.__ts = { contexts: [], lost: 0, frames: 0 };
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest);
    if (ctx) {
      w.__ts.contexts.push(String(type));
      if (String(type).startsWith('webgl')) this.addEventListener('webglcontextlost', () => { w.__ts.lost++; });
    }
    return ctx;
  };
  const raf = w.requestAnimationFrame.bind(w);
  w.requestAnimationFrame = (cb) => raf((t) => { w.__ts.frames++; cb(t); });
})();`;

export async function check(opts: CheckOptions): Promise<CheckResult> {
  const pw = await loadPlaywright();
  const isUrl = /^https?:\/\//.test(opts.target);
  const folder = isUrl ? process.cwd() : resolve(opts.target);
  const serveRoot = opts.root ? resolve(opts.root) : folder;
  const server = isUrl ? undefined : await serveStatic(serveRoot);
  const entryPath = relative(serveRoot, join(folder, opts.entry ?? "index.html")).split(sep).join("/");
  const url = isUrl ? opts.target : `${server?.url}/${entryPath}`;
  const stateDir = resolve(opts.stateDir ?? join(folder, ".threesmith"));
  const issues: Issue[] = [];
  const ignore = opts.ignore ?? [];
  const skip = (text: string) => ignore.some((i) => text.includes(i));

  const executablePath = findChromium();
  const browser = await pw.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [...WEBGL_ARGS, ...(opts.webgpu ? WEBGPU_ARGS : [])],
  });
  const result: CheckResult = {
    ok: false,
    url,
    issues,
    stats: { canvases: 0, contexts: [], frames: 0, threeRevision: null, dominantColor: 0, webgpuAdapter: null },
  };
  try {
    const page = await browser.newPage({ viewport: { width: opts.width ?? 800, height: opts.height ?? 600 }, deviceScaleFactor: 1 });
    await page.addInitScript(INIT);
    page.on("pageerror", (e) => issues.push({ kind: "page-error", severity: "error", message: String(e.message ?? e).split("\n")[0] ?? "" }));
    page.on("console", (m) => {
      const text = m.text();
      if (skip(text)) return;
      if (m.type() === "error") {
        // failed resource loads are reported by requestfailed/response with the URL
        if (/Failed to load resource/.test(text)) return;
        issues.push({ kind: "console-error", severity: "error", message: text.split("\n")[0] ?? "" });
      } else if (m.type() === "warning" && /THREE\./.test(text)) {
        issues.push({ kind: "console-warn", severity: "warn", message: text.split("\n")[0] ?? "" });
      }
    });
    page.on("requestfailed", (r) => {
      if (!skip(r.url())) issues.push({ kind: "request-failed", severity: "error", message: `${r.url()} (${r.failure()?.errorText ?? "failed"})` });
    });
    page.on("response", (r) => {
      if (r.status() >= 400 && !skip(r.url())) issues.push({ kind: "request-failed", severity: "error", message: `${r.url()} -> HTTP ${r.status()}` });
    });
    try {
      await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    } catch (e) {
      issues.push({ kind: "load-failed", severity: "error", message: `Could not open ${url}: ${(e as Error).message.split("\n")[0]}` });
      return result;
    }
    await page.waitForTimeout(opts.wait ?? 2000);
    const stats = await page.evaluate(`(async () => {
      const w = window;
      let adapter = null;
      if (navigator.gpu) {
        try { adapter = !!(await navigator.gpu.requestAdapter()); } catch { adapter = false; }
      }
      return {
        canvases: document.querySelectorAll("canvas").length,
        contexts: w.__ts.contexts,
        lost: w.__ts.lost,
        frames: w.__ts.frames,
        revision: w.__THREE__ ?? null,
        adapter,
      };
    })()`) as { canvases: number; contexts: string[]; lost: number; frames: number; revision: string | null; adapter: boolean | null };
    result.stats.canvases = stats.canvases;
    result.stats.contexts = stats.contexts;
    result.stats.frames = stats.frames;
    result.stats.threeRevision = stats.revision;
    result.stats.webgpuAdapter = opts.webgpu ? stats.adapter : null;

    const usesGpu = stats.contexts.some((c) => c.startsWith("webgl") || c === "webgpu");
    if (!stats.canvases) issues.push({ kind: "no-canvas", severity: "error", message: "The page has no <canvas>; the scene never attached its renderer." });
    else if (!usesGpu) issues.push({ kind: "no-webgl", severity: "error", message: "A canvas exists but no WebGL/WebGPU context was created on it." });
    if (stats.lost) issues.push({ kind: "context-lost", severity: "error", message: `The WebGL context was lost ${stats.lost} time(s).` });
    if (stats.canvases && stats.frames === 0 && !issues.some((i) => i.kind === "page-error")) {
      issues.push({ kind: "no-frames", severity: "warn", message: "No requestAnimationFrame callback ran. Fine for a static scene rendered once (or with setAnimationLoop on WebXR); otherwise the loop never started." });
    }

    const shot = await page.screenshot({ type: "png" });
    mkdirSync(stateDir, { recursive: true });
    const shotPath = join(stateDir, "last.png");
    writeFileSync(shotPath, shot);
    result.screenshot = shotPath;
    const img = decodePng(shot);
    // judge blankness on the largest canvas only: the page around it is usually one flat color
    let canvasImg = img;
    if (stats.canvases) {
      const sizes = (await page.evaluate(
        `Array.from(document.querySelectorAll("canvas")).map((c) => { const r = c.getBoundingClientRect(); return r.width * r.height; })`,
      )) as number[];
      const biggest = sizes.indexOf(Math.max(...sizes));
      try {
        canvasImg = decodePng(await page.locator("canvas").nth(biggest).screenshot({ type: "png", timeout: 5000 }));
      } catch {
        canvasImg = img;
      }
    }
    const bl = blankness(canvasImg);
    result.stats.dominantColor = Number(bl.dominant.toFixed(4));
    if (stats.canvases && bl.blank) {
      issues.push({ kind: "blank", severity: "error", message: `The screenshot is ${(bl.dominant * 100).toFixed(1)}% one color: nothing visible was drawn (no lights, camera inside the object, or nothing added to the scene?).` });
    }

    if (opts.baseline) {
      const dir = join(stateDir, "baselines");
      const file = join(dir, `${opts.baseline}.png`);
      const baseline: NonNullable<CheckResult["baseline"]> = { name: opts.baseline, status: "match" };
      result.baseline = baseline;
      let existing: Buffer | undefined;
      try {
        existing = readFileSync(file);
      } catch {
        existing = undefined; // no baseline yet
      }
      if (!existing || opts.updateBaseline) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, shot);
        baseline.status = existing ? "updated" : "created";
      } else {
        const expected = decodePng(existing);
        const d = diff(expected, img, { threshold: opts.threshold ?? 16 });
        baseline.ratio = Number(d.ratio.toFixed(5));
        if (d.sizeMismatch) {
          baseline.status = "size";
          issues.push({ kind: "baseline-size", severity: "error", message: `Screenshot is ${img.width}x${img.height}, baseline is ${expected.width}x${expected.height}.` });
        } else if (d.ratio > (opts.tolerance ?? 0.005)) {
          baseline.status = "diff";
          const diffPath = join(stateDir, "diff", `${opts.baseline}.png`);
          mkdirSync(dirname(diffPath), { recursive: true });
          if (d.image) writeFileSync(diffPath, encodePng(d.image));
          baseline.diffImage = diffPath;
          const box = d.box ? ` in a ${d.box.width}x${d.box.height} area at ${d.box.x},${d.box.y}` : "";
          issues.push({ kind: "baseline-diff", severity: "error", message: `${(d.ratio * 100).toFixed(2)}% of pixels changed${box} (limit ${((opts.tolerance ?? 0.005) * 100).toFixed(2)}%).` });
        }
      }
    }
  } finally {
    await browser.close();
    await server?.close();
  }
  result.ok = !issues.some((i) => i.severity === "error");
  return result;
}

export function formatCheck(r: CheckResult): string {
  const out = [`Threesmith check: ${r.ok ? "PASS" : "FAIL"} – ${r.url}`];
  const s = r.stats;
  out.push(`canvases ${s.canvases} · contexts ${s.contexts.join(",") || "none"} · frames ${s.frames} · three ${s.threeRevision ? "r" + s.threeRevision : "?"}`);
  for (const i of r.issues) out.push(`${i.severity === "error" ? "✖" : "▲"} [${i.kind}] ${i.message}`);
  if (r.baseline) out.push(`baseline ${r.baseline.name}: ${r.baseline.status}${r.baseline.ratio !== undefined ? ` (${(r.baseline.ratio * 100).toFixed(2)}% changed)` : ""}${r.baseline.diffImage ? ` – diff: ${r.baseline.diffImage}` : ""}`);
  if (r.screenshot) out.push(`screenshot: ${r.screenshot}`);
  return out.join("\n");
}
