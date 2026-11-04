import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Issue } from "./check.js";
import { INIT } from "./check.js";
import { INSPECT_INIT } from "./inspect.js";
import { openPage, type OpenedPage, type PageOptions } from "./page.js";
import { RUN_INIT } from "./runtime.js";
import { runStep, stepLabel, waitFrames, type PlayStep } from "./steps.js";
import { formatIssues, safeName } from "./util.js";

/**
 * Plays a page like a test would: opens it headless, runs steps (input, frames, code, waits for a condition),
 * samples watch expressions in the page after every step and while frames run, and checks claims about what it saw:
 * at the end, at any moment, or at every frame. What comes back is short: each watched value only when it changed,
 * each claim with the value, time, frame and step where it held or failed.
 */

export type ClaimAt = "end" | "any" | "always" | number;

/** A claim about the running page. `at` a number: right after that step (1-based; 0 is before the first step). */
export interface Claim {
  js: string;
  at?: ClaimAt;
}

export interface PlayOptions extends PageOptions {
  /** Milliseconds to let the scene start before the first step. Default 1000. */
  wait?: number;
  steps?: PlayStep[];
  /** JS expressions read in the page, with scene, renderer, camera, info, $(name) and $$(nameOrType) in scope. */
  watch?: string[];
  /** Claims: "$('player').position.y > 1 @ end", "any: $('box').visible === false", "always: info.render.calls < 200", or {js, at}. */
  expect?: (string | Claim)[];
  /** While frames run, record watch values at most this often (ms). Default 100. */
  sampleMs?: number;
  /** Screenshot at the end, as <stateDir>/play-<name>.png (default play.png). Default true. */
  screenshot?: boolean;
  /** Names the screenshot; scenarios pass theirs. */
  name?: string;
}

export interface Sample {
  /** Milliseconds since the first step started. */
  t: number;
  /** Animation frames since the first step started. */
  frame: number;
  /** Set when the sample was taken right after this step (1-based; 0 before the first step). */
  step?: number;
  /** For a sample taken at a frame: the step that was running then. */
  during?: number;
  v?: unknown;
  /** The expression threw. */
  e?: string;
}

export interface WatchSeries {
  js: string;
  /** Only the samples where the value changed. */
  series: Sample[];
  end?: unknown;
  error?: string;
  /** For numbers: the smallest and largest value seen. */
  min?: number;
  max?: number;
  /** All samples taken, changed or not. */
  samples: number;
}

export interface StepResult {
  n: number;
  label: string;
  ok: boolean;
  /** When the step started, ms since the first step. */
  t: number;
  frame: number;
  ms: number;
  value?: unknown;
  error?: string;
}

export interface ClaimResult {
  text: string;
  js: string;
  at: ClaimAt;
  ok: boolean;
  /** The left side of a comparison ("$('p').position.y" in "$('p').position.y > 1"), whose value is reported. */
  subject?: string;
  /** Value of the subject (or of the whole claim) where it held or failed; for a failed `any`, the last one. */
  value?: unknown;
  t?: number;
  frame?: number;
  step?: number;
  /** True when it was seen at a frame while that step ran, not right after it. */
  during?: boolean;
  /** For a failed `any` on a number: the range it moved in. */
  range?: [number, number];
  message: string;
}

export interface PlayResult {
  ok: boolean;
  url: string;
  steps: StepResult[];
  watch: WatchSeries[];
  claims: ClaimResult[];
  issues: Issue[];
  stats: {
    /** Milliseconds from the first step to the end. */
    ms: number;
    frames: number;
    threeRevision: string | null;
    scene: boolean;
    calls?: number;
    triangles?: number;
  };
  screenshot?: string;
}

const PREFIX = /^\s*(end|any|always)\s*:\s*([\s\S]+)$/;
const SUFFIX = /^([\s\S]+?)\s*@\s*(end|any|always|(?:step\s*)?\d+)\s*$/;

/** "x > 1 @ end", "any: x", "always: x", "x @ step 2" or {js, at} as a Claim. */
export function parseClaim(input: string | Claim): Required<Claim> {
  if (typeof input !== "string") {
    if (!input || typeof input.js !== "string" || !input.js.trim()) throw new Error("a claim needs js");
    const at = input.at ?? "end";
    if (!(at === "end" || at === "any" || at === "always" || (typeof at === "number" && Number.isInteger(at) && at >= 0))) throw new Error(`claim ${input.js}: at must be end, any, always or a step number`);
    return { js: input.js.trim(), at };
  }
  const p = PREFIX.exec(input);
  if (p) return { js: p[2]!.trim(), at: p[1] as ClaimAt };
  const s = SUFFIX.exec(input);
  if (s) {
    const at = s[2]!;
    return { js: s[1]!.trim(), at: /\d/.test(at) ? Number(at.replace(/\D/g, "")) : (at as ClaimAt) };
  }
  if (!input.trim()) throw new Error("empty claim");
  return { js: input.trim(), at: "end" };
}

/** A claim as text, the way parseClaim reads it back. */
export function claimText(c: Claim): string {
  const at = c.at ?? "end";
  return at === "any" || at === "always" ? `${at}: ${c.js}` : typeof at === "number" ? `${c.js} @ step ${at}` : `${c.js} @ end`;
}

/** The left side of a top-level comparison ("a.b > 1" gives "a.b"); undefined when the claim is not one comparison. */
export function claimSubject(js: string): string | undefined {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < js.length; i++) {
    const c = js[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0) {
      if ((c === "&" && js[i + 1] === "&") || (c === "|" && js[i + 1] === "|") || c === "?") return undefined;
      const two = js.slice(i, i + 2);
      if (c === "=" && js[i + 1] === ">") return undefined; // an arrow function
      if (["==", "!=", ">=", "<="].includes(two) || ((c === ">" || c === "<") && js[i - 1] !== "=")) {
        const lhs = js.slice(0, i).trim();
        if (!lhs) return undefined;
        // the rest must hold no second comparison (a < b < c reads as something else)
        const rest = js.slice(i + (["==", "!="].includes(two) && js[i + 2] === "=" ? 3 : ["==", "!=", ">=", "<="].includes(two) ? 2 : 1));
        if (/[<>]|[=!]=/.test(rest.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ""))) return undefined;
        return lhs;
      }
    }
  }
  return undefined;
}

/** Installs the sampler in the page: watch values and claims, read at every frame and after every step. */
type SamplerConfig = { watch: string[]; claims: { js: string; at: ClaimAt; subject?: string }[]; sampleMs: number };
// The watch and claim code reaches the page as data (window.__tsPlayCfg, set by an evaluate argument), never pasted into this script.
const SAMPLER = `(() => {
  const api = window.__threesmith, run = window.__tsRun;
  const cfg = window.__tsPlayCfg;
  const t0 = performance.now(), f0 = run.frame;
  const p = window.__tsPlay = {
    series: cfg.watch.map(() => []), last: cfg.watch.map(() => null), count: 0, lastSample: -1e9,
    min: cfg.watch.map(() => null), max: cfg.watch.map(() => null),
    claims: cfg.claims.map(() => ({ held: null, failed: null, value: undefined, min: null, max: null })),
    cur: 0,
    begin(n) { p.cur = n; return p.now(); },
    now() { return { t: Math.round(performance.now() - t0), frame: run.frame - f0 }; },
  };
  const truthy = (js) => { try { return { ok: !!api.call(js) }; } catch (e) { return { ok: false, e: String((e && e.message) || e) }; } };
  const valueOf = (c) => { const r = api.read(c.subject || c.js); return r; };
  const mark = (at, step, r) => { const x = Object.assign(p.now(), r.e !== undefined ? { e: r.e } : { v: r.v }); if (step !== undefined) x.step = step; else if (p.cur) x.during = p.cur; return x; };
  p.tick = (step, end) => {
    cfg.claims.forEach((c, i) => {
      const s = p.claims[i];
      const due = c.at === 'any' || c.at === 'always' || (c.at === 'end' && end) || (typeof c.at === 'number' && step === c.at && !end);
      if (!due) return;
      const r = truthy(c.js);
      if (c.at === 'always') { if (!r.ok && !s.failed) s.failed = mark(c.at, step, r.e !== undefined ? r : valueOf(c)); }
      else if (c.at === 'any') {
        if (s.held) return;
        if (r.ok) { s.held = mark(c.at, step, valueOf(c)); return; }
        const v = valueOf(c);
        s.value = v;
        if (typeof v.v === 'number') { s.min = s.min === null ? v.v : Math.min(s.min, v.v); s.max = s.max === null ? v.v : Math.max(s.max, v.v); }
      } else {
        const v = valueOf(c);
        if (r.ok) s.held = mark(c.at, step, v); else s.failed = mark(c.at, step, r.e !== undefined ? r : v);
      }
    });
    const { t } = p.now();
    if (step === undefined && !end && t - p.lastSample < cfg.sampleMs) return;
    p.lastSample = t;
    p.count++;
    cfg.watch.forEach((js, i) => {
      const r = api.read(js);
      if (typeof r.v === 'number') { p.min[i] = p.min[i] === null ? r.v : Math.min(p.min[i], r.v); p.max[i] = p.max[i] === null ? r.v : Math.max(p.max[i], r.v); }
      const key = JSON.stringify(r);
      if (key === p.last[i]) return;
      p.last[i] = key;
      p.series[i].push(mark(null, step, r));
    });
  };
  run.tick = () => p.tick();
  p.tick(0);
  return true;
})()`;

interface PageState {
  series: Sample[][];
  min: (number | null)[];
  max: (number | null)[];
  count: number;
  claims: { held: Sample | null; failed: Sample | null; value?: { v?: unknown; e?: string }; min: number | null; max: number | null }[];
}

/** Opens a page with the play runtime (INIT, inspect hook, __threesmith) installed. Shared by play, perf and leaks. */
export async function openRunPage(opts: PageOptions): Promise<OpenedPage> {
  return openPage({ ...opts, init: [INIT, INSPECT_INIT, RUN_INIT] });
}

export interface StepRunOptions {
  /** Called right after each step (one frame later), before the next. */
  after?: (n: number) => Promise<void>;
  /** Steps are numbered from here + 1 (leaks numbers steps across cycles). */
  offset?: number;
  /** Called as step n starts; gives the time base for StepResult.t. */
  clock?: (n: number) => Promise<{ t: number; frame: number }>;
}

/** Runs steps in order; stops at the first failure and adds a step-failed issue. */
export async function runSteps(o: OpenedPage, steps: PlayStep[], opts: StepRunOptions = {}): Promise<StepResult[]> {
  const out: StepResult[] = [];
  for (const [i, step] of steps.entries()) {
    const n = (opts.offset ?? 0) + i + 1;
    const at = opts.clock ? await opts.clock(n) : { t: 0, frame: 0 };
    const started = Date.now();
    const r: StepResult = { n, label: stepLabel(step), ok: true, t: at.t, frame: at.frame, ms: 0 };
    out.push(r);
    try {
      const value = await runStep(o.page, step);
      if (value !== undefined && value !== "undefined") r.value = value;
    } catch (e) {
      r.ok = false;
      r.error = (e as Error).message.split("\n")[0] ?? "failed";
      o.issues.push({ kind: "step-failed", severity: "error", message: `step ${n} (${r.label}) failed: ${r.error}` });
    }
    r.ms = Date.now() - started;
    if (!r.ok) break;
    await waitFrames(o.page, 1); // let the step's effect reach a frame
    await opts.after?.(n);
  }
  return out;
}

export async function play(opts: PlayOptions): Promise<PlayResult> {
  const claims = (opts.expect ?? []).map((c) => {
    const p = parseClaim(c);
    const subject = claimSubject(p.js);
    return { ...p, ...(subject ? { subject } : {}), text: typeof c === "string" ? c.trim() : claimText(p) };
  });
  const watch = [...new Set(opts.watch ?? [])];
  const o = await openRunPage(opts);
  const result: PlayResult = { ok: false, url: o.url, steps: [], watch: [], claims: [], issues: o.issues, stats: { ms: 0, frames: 0, threeRevision: null, scene: false } };
  try {
    if (!o.loaded) return finish(result, claims);
    await o.page.waitForTimeout(opts.wait ?? 1000);
    const cfg: SamplerConfig = { watch, claims: claims.map(({ js, at, subject }) => ({ js, at, ...(subject ? { subject } : {}) })), sampleMs: opts.sampleMs ?? 100 };
    await o.page.evaluate((c: SamplerConfig) => {
      (globalThis as unknown as { __tsPlayCfg: SamplerConfig }).__tsPlayCfg = c;
    }, cfg);
    await o.page.evaluate(SAMPLER);
    const clock = async (n: number) => (await o.page.evaluate(`window.__tsPlay.begin(${n})`)) as { t: number; frame: number };
    result.steps = await runSteps(o, opts.steps ?? [], { clock, after: async (n) => void (await o.page.evaluate(`window.__tsPlay.tick(${n})`)) });
    const end = (await o.page.evaluate(`(() => { const p = window.__tsPlay; window.__tsRun.tick = null; p.cur = 0; p.tick(undefined, true);
      const api = window.__threesmith; const info = api.info;
      return { state: { series: p.series, min: p.min, max: p.max, count: p.count, claims: p.claims }, now: p.now(), revision: window.__THREE__ || null, scene: !!api.scene,
        calls: info ? info.render.calls : undefined, triangles: info ? info.render.triangles : undefined }; })()`)) as {
      state: PageState;
      now: { t: number; frame: number };
      revision: string | null;
      scene: boolean;
      calls?: number;
      triangles?: number;
    };
    result.stats = {
      ms: end.now.t,
      frames: end.now.frame,
      threeRevision: end.revision,
      scene: end.scene,
      ...(end.calls !== undefined ? { calls: end.calls } : {}),
      ...(end.triangles !== undefined ? { triangles: end.triangles } : {}),
    };
    if (!end.scene && (watch.length || claims.length)) {
      o.issues.push({ kind: "scene", severity: "warn", message: "No three.js scene was announced on the page: scene, camera and $() are empty (three loaded as a module on this page announces its scenes; an older three or an iframe does not)." });
    }
    result.watch = watch.map((js, i) => {
      const series = end.state.series[i] ?? [];
      const last = series.at(-1);
      const w: WatchSeries = { js, series, samples: end.state.count };
      if (last?.e !== undefined && series.every((s) => s.e !== undefined)) w.error = last.e;
      else if (last) w.end = last.v;
      const min = end.state.min[i];
      const max = end.state.max[i];
      if (min !== null && min !== undefined && max !== null && max !== undefined && min !== max) Object.assign(w, { min, max });
      return w;
    });
    result.claims = claims.map((c, i) => judge(c, end.state.claims[i]!, result.steps));
    if (opts.screenshot !== false) {
      const shot = await o.page.screenshot({ type: "png" });
      mkdirSync(o.stateDir, { recursive: true });
      const file = join(o.stateDir, opts.name ? `play-${safeName(opts.name)}.png` : "play.png");
      writeFileSync(file, shot);
      result.screenshot = file;
    }
  } finally {
    await o.close();
  }
  return finish(result, claims);
}

function finish(r: PlayResult, claims: { js: string; at: ClaimAt; text: string; subject?: string }[]): PlayResult {
  if (!r.claims.length && claims.length) r.claims = claims.map((c) => ({ text: c.text, js: c.js, at: c.at, ok: false, message: "not checked: the page did not run" }));
  r.ok = !r.issues.some((i) => i.severity === "error") && r.claims.every((c) => c.ok) && r.steps.every((s) => s.ok);
  return r;
}

const show = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : v === undefined ? "undefined" : JSON.stringify(v));
const when = (s: Sample) => `${s.t}ms f${s.frame}${s.step !== undefined ? (s.step === 0 ? " before step 1" : ` after step ${s.step}`) : s.during ? ` during step ${s.during}` : ""}`;

function judge(c: { js: string; at: ClaimAt; text: string; subject?: string }, s: PageState["claims"][number], steps: StepResult[]): ClaimResult {
  const base = { text: c.text, js: c.js, at: c.at, ...(c.subject ? { subject: c.subject } : {}) };
  const what = c.subject ?? c.js;
  const place = (x: Sample) => ({ t: x.t, frame: x.frame, ...(x.step !== undefined ? { step: x.step } : x.during ? { step: x.during, during: true } : {}), ...(x.e === undefined ? { value: x.v } : {}) });
  const val = (x: Sample) => (x.e !== undefined ? `threw ${x.e}` : `${what} was ${show(x.v)}`);
  if (c.at === "always") {
    if (s.failed) return { ...base, ok: false, ...place(s.failed), message: `failed at ${when(s.failed)}: ${val(s.failed)}` };
    return { ...base, ok: true, message: "held at every frame and step" };
  }
  if (c.at === "any") {
    if (s.held) return { ...base, ok: true, ...place(s.held), message: `first held at ${when(s.held)} (${val(s.held)})` };
    const last = s.value;
    const range: [number, number] | undefined = s.min !== null && s.max !== null ? [s.min, s.max] : undefined;
    return {
      ...base,
      ok: false,
      ...(last && last.e === undefined ? { value: last.v } : {}),
      ...(range ? { range } : {}),
      message: `never held${range && range[0] !== range[1] ? `: ${what} moved between ${range[0]} and ${range[1]}` : last ? `: ${last.e !== undefined ? `threw ${last.e}` : `${what} stayed ${show(last.v)}`}` : ""}`,
    };
  }
  const hit = s.held ?? s.failed;
  if (!hit) {
    const ran = steps.length;
    return { ...base, ok: false, message: typeof c.at === "number" ? `step ${c.at} was not reached (${ran} step${ran === 1 ? "" : "s"} ran)` : "the run did not reach the end" };
  }
  if (s.held) return { ...base, ok: true, ...place(s.held), message: `held (${val(s.held)})` };
  return { ...base, ok: false, ...place(hit), message: `failed at ${when(hit)}: ${val(hit)}` };
}

/** A watched series in one line: the changes (long ones shortened), the range for numbers. */
function seriesLine(w: WatchSeries): string {
  if (w.error !== undefined) return `${w.js}: error: ${w.error}`;
  if (!w.series.length) return `${w.js}: not sampled`;
  const point = (s: Sample) => `${s.e !== undefined ? `threw ${s.e}` : show(s.v)} @${s.t}ms`;
  const parts = w.series.length > 10 ? [...w.series.slice(0, 5).map(point), `… ${w.series.length - 9} more …`, ...w.series.slice(-4).map(point)] : w.series.map(point);
  const changes = w.series.length - 1;
  const tail = changes === 0 ? " (never changed)" : ` (${changes} change${changes === 1 ? "" : "s"} in ${w.samples} samples${w.min !== undefined ? `, min ${w.min} max ${w.max}` : ""})`;
  return `${w.js}: ${parts.join(" → ")}${tail}`;
}

export function formatClaims(claims: ClaimResult[]): string[] {
  if (!claims.length) return [];
  const failed = claims.filter((c) => !c.ok).length;
  return [failed ? `claims: ${failed} of ${claims.length} FAILED` : `claims: all ${claims.length} hold`, ...claims.map((c) => `  ${c.ok ? "ok  " : "FAIL"} ${c.text}  -> ${c.message}`)];
}

export function formatPlay(r: PlayResult): string {
  const s = r.stats;
  const out = [`Threesmith play: ${r.ok ? "PASS" : "FAIL"} – ${r.url}`];
  out.push(`${r.steps.length} step${r.steps.length === 1 ? "" : "s"} in ${s.ms} ms, ${s.frames} frames · three ${s.threeRevision ? "r" + s.threeRevision : "?"}${s.calls !== undefined ? ` · last frame ${s.calls} draw calls, ${s.triangles} triangles` : ""}`);
  if (r.steps.length) {
    out.push("steps:");
    for (const st of r.steps) out.push(`  ${st.ok ? " " : "✖"}${String(st.n).padStart(2)} ${st.label}  @${st.t}ms f${st.frame}${st.value !== undefined ? `  = ${show(st.value)}` : ""}${st.ok ? "" : `  ${st.error}`}`);
  }
  if (r.watch.length) out.push("watch:", ...r.watch.map((w) => `  ${seriesLine(w)}`));
  out.push(...formatClaims(r.claims));
  out.push(...formatIssues(r.issues.filter((i) => i.kind !== "step-failed")));
  if (r.screenshot) out.push(`screenshot: ${r.screenshot}`);
  return out.join("\n");
}
