import { join, relative, resolve, sep } from "node:path";
import { findChromium, loadPlaywright, WEBGL_ARGS, WEBGPU_ARGS } from "../check/browser.js";
import { blankness } from "../check/diff.js";
import { INSPECT_EVAL, INSPECT_INIT, formatScene, type SceneReport } from "../check/inspect.js";
import { decodePng } from "../check/png.js";
import { serveStatic, type StaticServer } from "../check/server.js";
import type { Step } from "../check/check.js";
import { explain } from "../explain/explain.js";

/**
 * A page that stays open between tool calls: load the scene once (a big world, a level reached after a menu) and then
 * look at it and drive it — read and change live values, run JS against the running scene, interact, wait frames,
 * take screenshots, inspect why something is not visible — with the new console errors after every answer. It lives
 * in the MCP server process, headless, and stops by itself after a while without calls.
 */

type Browser = Awaited<ReturnType<Awaited<ReturnType<typeof loadPlaywright>>["chromium"]["launch"]>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

export interface SessionOptions {
  target: string;
  entry?: string;
  root?: string;
  width?: number;
  height?: number;
  /** ms to let the scene run after load. Default 1500. */
  wait?: number;
  webgpu?: boolean;
  /** Stop after this many ms without a call. Default 10 minutes. */
  idleMs?: number;
}

interface LiveError {
  kind: string;
  message: string;
  fix?: string;
}

interface Session {
  name: string;
  url: string;
  browser: Browser;
  page: Page;
  server?: StaticServer;
  errors: LiveError[];
  /** Index of the first error not yet reported. */
  seen: number;
  started: number;
  timer?: NodeJS.Timeout;
  idleMs: number;
}

const sessions = new Map<string, Session>();

/** Helpers every eval gets: scene, camera, renderer (the last ones rendered), $(name), $$(type), THREE (when global). */
const HELPERS = `(() => {
  const w = window;
  if (w.__threesmith) return;
  const last = () => (w.__tsScene && w.__tsScene.last) || {};
  const round = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 1000) / 1000 : n);
  const plain = (v, depth, seen) => {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === 'number') return round(v);
    if (t === 'string') return v.length > 500 ? v.slice(0, 500) + '…' : v;
    if (t === 'boolean') return v;
    if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (t === 'bigint') return String(v);
    if (seen.has(v)) return '[circular]';
    if (v.isVector2) return [round(v.x), round(v.y)];
    if (v.isVector3) return [round(v.x), round(v.y), round(v.z)];
    if (v.isVector4 || v.isQuaternion) return [round(v.x), round(v.y), round(v.z), round(v.w)];
    if (v.isEuler) return [round(v.x), round(v.y), round(v.z), v.order];
    if (v.isColor) return '#' + v.getHexString();
    if (v.isMatrix4 || v.isMatrix3) return Array.from(v.elements, round);
    if (v.isBox3) return { min: plain(v.min, 1, seen), max: plain(v.max, 1, seen) };
    if (v.isObject3D) {
      const o = { type: v.type, name: v.name || undefined, position: plain(v.position, 1, seen), visible: v.visible, children: v.children.length };
      if (depth > 0) { o.rotation = plain(v.rotation, 1, seen); o.scale = plain(v.scale, 1, seen); if (v.material) o.material = v.material.type || (Array.isArray(v.material) ? 'multi' : undefined); if (v.geometry) o.geometry = v.geometry.type; }
      return o;
    }
    if (v.isMaterial) return { type: v.type, name: v.name || undefined, visible: v.visible, transparent: v.transparent, opacity: round(v.opacity), color: v.color ? '#' + v.color.getHexString() : undefined };
    if (v.isBufferGeometry) return { type: v.type, vertices: v.attributes && v.attributes.position ? v.attributes.position.count : 0, index: !!v.index };
    if (v.isTexture) return { type: 'Texture', name: v.name || undefined, size: v.image ? [v.image.width, v.image.height] : null, colorSpace: v.colorSpace };
    if (ArrayBuffer.isView(v)) return Array.from(v.slice(0, 32), round).concat(v.length > 32 ? ['…' + v.length] : []);
    if (v instanceof Element) return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + '>';
    seen.add(v);
    if (Array.isArray(v)) return depth < 0 ? '[array ' + v.length + ']' : v.slice(0, 50).map((x) => plain(x, depth - 1, seen)).concat(v.length > 50 ? ['…' + v.length] : []);
    if (depth < 0) return '[object]';
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) { if (n++ >= 30) { out['…'] = Object.keys(v).length + ' keys'; break; } try { out[k] = plain(v[k], depth - 1, seen); } catch (e) { out[k] = '[unreadable]'; } }
    return out;
  };
  w.__threesmith = {
    get scene() { return last().scene || (w.__tsScene && w.__tsScene.scenes[0]); },
    get camera() { return last().camera; },
    get renderer() { return last().renderer || (w.__tsScene && w.__tsScene.renderers[0]); },
    $(name) { const s = this.scene; return s ? s.getObjectByName(name) : undefined; },
    $$(type) { const s = this.scene; const out = []; if (s) s.traverse((o) => { if (o.type === type || o.name === type) out.push(o); }); return out; },
    plain: (v, depth) => plain(v, depth === undefined ? 2 : depth, new Set()),
  };
})();`;

function expressionFor(js: string): string {
  // a single expression is returned; statements run as a function body (use `return`)
  const body = /\breturn\b|;\s*\S|^\s*(?:const|let|var|if|for|while)\b/.test(js) ? js : `return (${js});`;
  return `(async () => {
    const ts = window.__threesmith; const scene = ts.scene, camera = ts.camera, renderer = ts.renderer;
    const $ = (n) => ts.$(n), $$ = (t) => ts.$$(t);
    const THREE = window.THREE;
    try { const v = await (async () => { ${body} })(); return { ok: true, value: ts.plain(v) }; }
    catch (e) { return { ok: false, error: String(e && e.stack || e).split('\\n').slice(0, 3).join('\\n') }; }
  })()`;
}

function touch(s: Session): void {
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => void stopSession(s.name), s.idleMs);
  s.timer.unref?.();
}

function drain(s: Session): LiveError[] {
  const fresh = s.errors.slice(s.seen);
  s.seen = s.errors.length;
  return fresh;
}

export interface StartResult {
  name: string;
  url: string;
  threeRevision: string | null;
  canvases: number;
  frames: number;
  objects: number;
  errors: LiveError[];
  replaced: boolean;
}

export async function startSession(opts: SessionOptions, name = "main"): Promise<StartResult> {
  const replaced = sessions.has(name);
  if (replaced) await stopSession(name);
  const pw = await loadPlaywright();
  const isUrl = /^https?:\/\//.test(opts.target);
  const folder = isUrl ? process.cwd() : resolve(opts.target);
  const serveRoot = opts.root ? resolve(opts.root) : folder;
  const server = isUrl ? undefined : await serveStatic(serveRoot);
  const entry = relative(serveRoot, join(folder, opts.entry ?? "index.html")).split(sep).join("/");
  const url = isUrl ? opts.target : `${server!.url}/${entry}`;
  const executablePath = findChromium();
  const browser = await pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: [...WEBGL_ARGS, ...(opts.webgpu ? WEBGPU_ARGS : [])] });
  const page = await browser.newPage({ viewport: { width: opts.width ?? 800, height: opts.height ?? 600 }, deviceScaleFactor: 1 });
  const s: Session = { name, url, browser, page, ...(server ? { server } : {}), errors: [], seen: 0, started: Date.now(), idleMs: opts.idleMs ?? 10 * 60_000 };
  const add = (kind: string, text: string) => {
    if (s.errors.length > 500) return;
    const ex = explain(text)[0];
    s.errors.push({ kind, message: text.split("\n")[0]!.slice(0, 400), ...(ex ? { fix: ex.fix } : {}) });
  };
  page.on("pageerror", (e) => add("page-error", String(e.message ?? e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) add("console-error", m.text());
    else if (m.type() === "warning" && /THREE\./.test(m.text())) add("console-warn", m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400) add("request-failed", `${r.url()} -> HTTP ${r.status()}`);
  });
  page.on("requestfailed", (r) => add("request-failed", `${r.url()} (${r.failure()?.errorText ?? "failed"})`));
  await page.addInitScript(INSPECT_INIT);
  await page.addInitScript(HELPERS);
  sessions.set(name, s);
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  } catch (e) {
    await stopSession(name);
    throw new Error(`Could not open ${url}: ${(e as Error).message.split("\n")[0]}`);
  }
  await page.waitForTimeout(opts.wait ?? 1500);
  touch(s);
  const info = (await page.evaluate(`(() => { const ts = window.__threesmith; let n = 0; if (ts.scene) ts.scene.traverse(() => n++); return { rev: window.__THREE__ || null, canvases: document.querySelectorAll('canvas').length, frames: (window.__tsScene && window.__tsScene.renders) || 0, objects: n }; })()`)) as {
    rev: string | null;
    canvases: number;
    frames: number;
    objects: number;
  };
  return { name, url, threeRevision: info.rev, canvases: info.canvases, frames: info.frames, objects: info.objects, errors: drain(s), replaced };
}

export async function stopSession(name = "main"): Promise<boolean> {
  const s = sessions.get(name);
  if (!s) return false;
  sessions.delete(name);
  if (s.timer) clearTimeout(s.timer);
  await s.browser.close().catch(() => undefined);
  await s.server?.close().catch(() => undefined);
  return true;
}

export async function stopAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map((n) => stopSession(n)));
}

export function listSessions(): { name: string; url: string; minutes: number }[] {
  return [...sessions.values()].map((s) => ({ name: s.name, url: s.url, minutes: Math.round((Date.now() - s.started) / 60000) }));
}

function get(name: string): Session {
  const s = sessions.get(name);
  if (!s) throw new Error(`No live page "${name}". Start one with three_session op start (target: the folder or dev server URL).`);
  touch(s);
  return s;
}

export type PageOp =
  | { op: "eval"; js: string }
  | { op: "steps"; steps: Step[] }
  | { op: "frames"; n: number }
  | { op: "until"; js: string; timeout?: number }
  | { op: "screenshot" }
  | { op: "inspect"; maxNodes?: number }
  | { op: "reload"; wait?: number }
  | { op: "errors" };

export interface PageAnswer {
  text: string;
  value?: unknown;
  image?: Buffer;
  ok: boolean;
  errors: LiveError[];
}

async function runSteps(page: Page, steps: Step[]): Promise<string[]> {
  const done: string[] = [];
  for (const [i, step] of steps.entries()) {
    if (step.type === "wait") await page.waitForTimeout(Math.min(step.ms, 30_000));
    else if (step.type === "click") {
      if (step.selector) await page.click(step.selector, { timeout: 5000 });
      else await page.mouse.click(step.x ?? 0, step.y ?? 0);
    } else if (step.type === "press") await page.keyboard.press(step.key);
    else if (step.type === "drag") {
      await page.mouse.move(step.from[0], step.from[1]);
      await page.mouse.down();
      await page.mouse.move(step.to[0], step.to[1], { steps: 12 });
      await page.mouse.up();
    } else if (step.type === "wheel") await page.mouse.wheel(0, step.deltaY);
    else if (step.type === "wait-for") await page.waitForSelector(step.selector, { timeout: step.timeout ?? 5000 });
    done.push(`${i + 1}. ${step.type}`);
    await page.waitForTimeout(50);
  }
  return done;
}

const show = (v: unknown): string => {
  const t = JSON.stringify(v);
  return t === undefined ? "undefined" : t.length > 6000 ? t.slice(0, 6000) + "…" : t;
};

export async function pageOp(op: PageOp, name = "main"): Promise<PageAnswer> {
  const s = get(name);
  const page = s.page;
  let text = "";
  let value: unknown;
  let image: Buffer | undefined;
  let ok = true;
  switch (op.op) {
    case "eval": {
      const r = (await page.evaluate(expressionFor(op.js))) as { ok: boolean; value?: unknown; error?: string };
      ok = r.ok;
      value = r.value;
      text = r.ok ? show(r.value) : `error: ${r.error}`;
      break;
    }
    case "steps": {
      try {
        text = `ran ${(await runSteps(page, op.steps)).length} step(s)`;
      } catch (e) {
        ok = false;
        text = `step failed: ${(e as Error).message.split("\n")[0]}`;
      }
      break;
    }
    case "frames": {
      const n = Math.max(1, Math.min(op.n, 600));
      await page.evaluate(`new Promise((done) => { let i = 0; const f = () => (++i >= ${n} ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
      text = `waited ${n} frame(s)`;
      break;
    }
    case "until": {
      const timeout = Math.min(op.timeout ?? 5000, 60_000);
      const start = Date.now();
      let last: unknown;
      for (;;) {
        const r = (await page.evaluate(expressionFor(op.js))) as { ok: boolean; value?: unknown; error?: string };
        if (!r.ok) {
          ok = false;
          text = `error: ${r.error}`;
          break;
        }
        last = r.value;
        if (r.value) {
          text = `true after ${Date.now() - start} ms`;
          break;
        }
        if (Date.now() - start > timeout) {
          ok = false;
          text = `still ${show(last)} after ${timeout} ms`;
          break;
        }
        await page.waitForTimeout(50);
      }
      value = last;
      break;
    }
    case "screenshot": {
      image = await page.screenshot({ type: "png" });
      const b = blankness(decodePng(image));
      text = b.blank ? `screenshot: ${(b.dominant * 100).toFixed(1)}% one colour, nothing visible drawn` : `screenshot: ${(100 - b.dominant * 100).toFixed(1)}% of the picture is not the background colour`;
      break;
    }
    case "inspect": {
      const r = (await page.evaluate(INSPECT_EVAL)) as SceneReport;
      text = formatScene(r, { maxNodes: op.maxNodes ?? 60 });
      break;
    }
    case "reload": {
      await page.reload({ waitUntil: "load", timeout: 30_000 });
      await page.waitForTimeout(op.wait ?? 1500);
      text = "reloaded (the page state starts over; edited files are loaded)";
      break;
    }
    case "errors":
      text = s.errors.length ? `${s.errors.length} error(s) since start` : "no errors since start";
      break;
  }
  const errors = op.op === "errors" ? s.errors.slice(-30) : drain(s);
  if (op.op === "errors") s.seen = s.errors.length;
  return { text, ...(value !== undefined ? { value } : {}), ...(image ? { image } : {}), ok, errors };
}

export function formatErrors(errors: LiveError[], max = 10): string {
  if (!errors.length) return "";
  const out = [`${errors.length} new error(s) in the page:`];
  for (const e of errors.slice(0, max)) out.push(`  ${e.kind}: ${e.message}${e.fix ? ` Fix: ${e.fix}` : ""}`);
  if (errors.length > max) out.push(`  +${errors.length - max} more (op errors)`);
  return out.join("\n");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void stopAll().finally(() => process.exit(0)));
process.once("beforeExit", () => void stopAll());
