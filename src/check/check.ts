import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blankness, diff } from "./diff.js";
import { decodePng, encodePng } from "./png.js";
import type { Explanation } from "../explain/explain.js";
import { openPage } from "./page.js";
import { runStep } from "./steps.js";
import { formatIssues } from "./util.js";
import { INSPECT_EVAL, INSPECT_INIT, MEMORY_EVAL, formatScene, type SceneReport } from "./inspect.js";

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
  /** Steps to run (click, press, drag, wheel, wait) after the scene has started and before the screenshot. */
  steps?: Step[];
  /** Read the live scene graph and diagnose why objects are not visible. Done anyway when the frame is blank. */
  inspect?: boolean;
  /** Sample GPU memory twice this many ms apart to catch leaks (0 = off). Default 1500 with inspect, else 0. */
  leakMs?: number;
  /** Console warnings that are not a problem. Substring match. */
  ignore?: string[];
}

/** Things to do on the page before the screenshot, in order. */
export type Step =
  | { type: "wait"; ms: number }
  | { type: "click"; selector?: string; x?: number; y?: number }
  | { type: "press"; key: string }
  | { type: "drag"; from: [number, number]; to: [number, number] }
  | { type: "wheel"; deltaY: number }
  | { type: "wait-for"; selector: string; timeout?: number };

export function parseSteps(input: string): Step[] {
  const data = JSON.parse(input) as unknown;
  if (!Array.isArray(data)) throw new Error("steps must be a JSON array");
  const types = new Set(["wait", "click", "press", "drag", "wheel", "wait-for"]);
  for (const s of data) {
    if (!s || typeof s !== "object" || !types.has((s as { type?: string }).type ?? "")) {
      throw new Error(`unknown step ${JSON.stringify(s)}; types: ${[...types].join(", ")}`);
    }
  }
  return data as Step[];
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
  | "step-failed"
  | "scene"
  | "leak"
  | "load-failed";

export interface Issue {
  kind: IssueKind;
  severity: "error" | "warn";
  message: string;
  /** Full text of a console message (shader errors span many lines). */
  detail?: string;
  /** Known causes and fixes for this message. */
  explanations?: Explanation[];
  /** For shader errors: where the failing line is in the project. */
  shader?: { stage: string; line: number; message: string; code?: string; source?: string }[];
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
  scene?: SceneReport;
  baseline?: { name: string; status: "created" | "updated" | "match" | "diff" | "size" | "missing"; ratio?: number; diffImage?: string };
}

/** Counts contexts, lost contexts and animation frames. Runs before any page script. */
export const INIT = `(() => {
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
  const opened = await openPage({ ...opts, init: [INIT, INSPECT_INIT] });
  const { page, url, issues } = opened;
  const stateDir = opened.stateDir;
  const result: CheckResult = {
    ok: false,
    url,
    issues,
    stats: { canvases: 0, contexts: [], frames: 0, threeRevision: null, dominantColor: 0, webgpuAdapter: null },
  };
  try {
    if (!opened.loaded) return result;
    await page.waitForTimeout(opts.wait ?? 2000);
    for (const [i, step] of (opts.steps ?? []).entries()) {
      try {
        await runStep(page, step);
      } catch (e) {
        issues.push({ kind: "step-failed", severity: "error", message: `step ${i + 1} (${step.type}) failed: ${(e as Error).message.split("\n")[0]}` });
        break;
      }
      await page.waitForTimeout(100); // let the next frame draw
    }
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

    const blank = issues.some((i) => i.kind === "blank");
    if ((opts.inspect || blank) && stats.canvases) {
      const leakMs = opts.leakMs ?? (opts.inspect ? 1500 : 0);
      const before = leakMs > 0 ? ((await page.evaluate(MEMORY_EVAL)) as { geometries: number; textures: number } | null) : null;
      if (before) await page.waitForTimeout(leakMs);
      const after = before ? ((await page.evaluate(MEMORY_EVAL)) as { geometries: number; textures: number } | null) : null;
      const scene = (await page.evaluate(INSPECT_EVAL)) as SceneReport;
      if (before && after) scene.memory = { before, after, ms: leakMs };
      result.scene = scene;
      for (const d of scene.diagnoses.filter((x) => x.severity === "error")) {
        issues.push({ kind: "scene", severity: blank ? "error" : "warn", message: `${d.object ? d.object + ": " : ""}${d.message} Fix: ${d.fix}` });
      }
      if (before && after) {
        const g = after.geometries - before.geometries;
        const t = after.textures - before.textures;
        if (g >= 3 || t >= 3) {
          issues.push({
            kind: "leak",
            severity: "warn",
            message: `GPU memory keeps growing while the scene runs: +${g} geometries, +${t} textures in ${leakMs} ms. Something creates geometries/materials/textures every frame or replaces objects without dispose().`,
          });
        }
      }
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
    await opened.close();
  }
  result.ok = !issues.some((i) => i.severity === "error");
  return result;
}

export function formatCheck(r: CheckResult): string {
  const out = [`Threesmith check: ${r.ok ? "PASS" : "FAIL"} – ${r.url}`];
  const s = r.stats;
  out.push(`canvases ${s.canvases} · contexts ${s.contexts.join(",") || "none"} · frames ${s.frames} · three ${s.threeRevision ? "r" + s.threeRevision : "?"}`);
  out.push(...formatIssues(r.issues));
  if (r.scene) out.push("", formatScene(r.scene, { maxNodes: 40 }));
  if (r.baseline) out.push(`baseline ${r.baseline.name}: ${r.baseline.status}${r.baseline.ratio !== undefined ? ` (${(r.baseline.ratio * 100).toFixed(2)}% changed)` : ""}${r.baseline.diffImage ? ` – diff: ${r.baseline.diffImage}` : ""}`);
  if (r.screenshot) out.push(`screenshot: ${r.screenshot}`);
  return out.join("\n");
}
