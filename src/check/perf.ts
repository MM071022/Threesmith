import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Issue } from "./check.js";
import { openRunPage, runSteps } from "./play.js";
import type { FrameRecord } from "./runtime.js";
import type { PlayStep } from "./steps.js";
import type { PageOptions } from "./page.js";
import { formatIssues, round, safeName, signed, type Writer } from "./util.js";

/**
 * Measures a page over a few seconds: frame intervals from requestAnimationFrame (percentiles and the slowest frames,
 * each with what happened on it), script time inside the frame callbacks, draw calls and triangles per frame, shader
 * programs, geometries and textures, the JS heap; checks budgets and compares with the last run.
 *
 * Headless Chromium draws with SwiftShader, WebGL on the CPU: frame times say how this run compares with the last
 * one on the same machine, not what a GPU would do. Draw calls, triangles, programs, geometries and textures do
 * not depend on the GPU and are exact.
 */

export const TIMING_NOTE =
  "Frame times come from SwiftShader (WebGL rasterized on the CPU, headless): compare them before/after on the same machine, not with a real GPU. Draw calls, triangles, programs, geometries and textures are exact.";

export interface PerfBudget {
  /** p95 frame interval, ms. */
  frameMs?: number;
  /** Most draw calls in one frame. */
  calls?: number;
  /** Most triangles in one frame. */
  triangles?: number;
  /** Textures on the GPU at the end. */
  textures?: number;
  geometries?: number;
  programs?: number;
}

export interface PerfOptions extends PageOptions {
  /** Milliseconds to let the scene start before the steps. Default 1000. */
  wait?: number;
  /** Steps to run first (open a level, start a fight); not measured. */
  steps?: PlayStep[];
  /** Seconds to measure. Default 5. */
  seconds?: number;
  /** Milliseconds run after the steps before measuring. Default 500. */
  warmupMs?: number;
  budget?: PerfBudget;
  /** Name of the measurement, for the comparison file <stateDir>/perf/<name>.json. Default: the entry file name. */
  name?: string;
  /** Compare with the last run and save this one. Default true. */
  save?: boolean;
  /** Writes the comparison file; the lead passes the journal's writer. Default: a plain write. */
  write?: Writer;
}

export interface Stats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface SlowFrame {
  /** Frame index in the measurement. */
  frame: number;
  /** ms since the measurement started. */
  t: number;
  ms: number;
  scriptMs: number;
  calls: number;
  triangles: number;
  cause: string;
}

/** What is kept of a run to compare the next with. */
export interface PerfSummary {
  date: string;
  frames: number;
  frame: Stats;
  script: Stats;
  calls: { avg: number; max: number };
  triangles: { avg: number; max: number };
  programs: number;
  geometries: number;
  textures: number;
  heapMb?: number;
}

export interface BudgetResult {
  metric: keyof PerfBudget;
  limit: number;
  actual: number;
  ok: boolean;
}

export interface PerfResult extends PerfSummary {
  ok: boolean;
  url: string;
  name: string;
  seconds: number;
  slowest: SlowFrame[];
  budgets: BudgetResult[];
  previous?: PerfSummary;
  /** This run minus the last one. */
  delta?: Partial<Record<"frameP50" | "frameP95" | "scriptP95" | "calls" | "triangles" | "programs" | "geometries" | "textures" | "heapMb", number>>;
  /** Worse than the last run: frame p95 more than 20% and 2 ms up, or draw calls / triangles more than 10% up. */
  regressed: boolean;
  verdict: "ok" | "over budget" | "worse than before";
  /** The comparison file. */
  file: string;
  saved: boolean;
  issues: Issue[];
  note: string;
}

export function stats(values: number[]): Stats {
  if (!values.length) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return { p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted.at(-1)!), mean: round(values.reduce((a, b) => a + b, 0) / values.length) };
}

/**
 * Why a frame was slow, from what changed on it or on the two frames before: the GPU process (SwiftShader here)
 * compiles shaders and uploads buffers after the frame that asked for it, so the cost often shows a frame or two later.
 * Counters in a record are read after that frame rendered, so a frame's change is its record minus the one before.
 */
function causeOf(frames: FrameRecord[], i: number, usualCalls: number): string {
  const f = frames[i]!;
  const base = frames[Math.max(0, i - 3)]!;
  const [dt, cpu, calls, , programs, geometries, textures] = f;
  const why: string[] = [];
  const later = i >= 1 ? " (this frame or the two before)" : "";
  if (programs > base[4]) why.push(`${programs - base[4]} shader program(s) compiled${later}: first use of a material or light setup; warm up with renderer.compile(scene, camera)`);
  if (geometries > base[5] || textures > base[6]) {
    const parts = [geometries > base[5] ? `${geometries - base[5]} geometries` : "", textures > base[6] ? `${textures - base[6]} textures` : ""].filter(Boolean);
    why.push(`uploaded ${parts.join(" and ")} to the GPU${later}: new objects or a load finished`);
  }
  if (calls > usualCalls * 1.5 && calls - usualCalls >= 10) why.push(`${calls} draw calls (usually ${usualCalls})`);
  if (cpu > dt * 0.5) why.push(`${round(cpu)} ms of JS in the frame callbacks (update code, render() submission)`);
  else {
    const prev = frames[i - 1];
    if (prev && prev[1] > 8) why.push(`the frame before ran ${round(prev[1])} ms of JS`);
  }
  if (!why.length) why.push("outside the frame callbacks: rasterizing (fill rate, shadows, post-processing), garbage collection or timers");
  return why.join("; ");
}

function perfFile(stateDir: string, name: string): string {
  return join(stateDir, "perf", `${safeName(name)}.json`);
}

const defaultWriter: Writer = (p, data) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};

/** Turns recorded frames into a result: the pure part of perf, tested without a browser. */
export function summarize(frames: FrameRecord[], o: { budget?: PerfBudget; previous?: PerfSummary; heapMb?: number; date?: string } = {}): Omit<PerfResult, "ok" | "url" | "name" | "seconds" | "file" | "saved" | "issues"> {
  const n = frames.length;
  const col = (i: number) => frames.map((f) => f[i] as number);
  const calls = col(2);
  const tris = col(3);
  const last = frames.at(-1);
  const usualCalls = stats(calls).p50;
  const summary: PerfSummary = {
    date: o.date ?? new Date().toISOString(),
    frames: n,
    frame: stats(col(0)),
    script: stats(col(1)),
    calls: { avg: n ? round(calls.reduce((a, b) => a + b, 0) / n, 1) : 0, max: Math.max(0, ...calls) },
    triangles: { avg: n ? Math.round(tris.reduce((a, b) => a + b, 0) / n) : 0, max: Math.max(0, ...tris) },
    programs: last?.[4] ?? 0,
    geometries: last?.[5] ?? 0,
    textures: last?.[6] ?? 0,
    ...(o.heapMb !== undefined ? { heapMb: o.heapMb } : {}),
  };
  let t = 0;
  const timed = frames.map((f, i) => {
    t += f[0];
    return { f, i, t: Math.round(t) };
  });
  const median = summary.frame.p50;
  // The slow frames with a known cause (shader compiles, GPU uploads) always make the list, even when a busy machine
  // makes other frames slower for no reason in the page: those are the frames a fix can change.
  const slow = timed
    .filter((x) => x.f[0] > Math.max(median * 1.3, median + 4))
    .map((x) => ({ ...x, cause: causeOf(frames, x.i, usualCalls) }))
    .sort((a, b) => b.f[0] - a.f[0]);
  const known = slow.filter((x) => /shader program|uploaded/.test(x.cause)).slice(0, 2);
  const picked = [...known, ...slow.filter((x) => !known.includes(x))].slice(0, 5).sort((a, b) => b.f[0] - a.f[0]);
  const slowest: SlowFrame[] = picked.map((x) => ({ frame: x.i, t: x.t, ms: x.f[0], scriptMs: x.f[1], calls: x.f[2], triangles: x.f[3], cause: x.cause }));
  const b = o.budget ?? {};
  const actual: Record<keyof PerfBudget, number> = {
    frameMs: summary.frame.p95,
    calls: summary.calls.max,
    triangles: summary.triangles.max,
    textures: summary.textures,
    geometries: summary.geometries,
    programs: summary.programs,
  };
  const budgets: BudgetResult[] = (Object.keys(actual) as (keyof PerfBudget)[])
    .filter((k) => b[k] !== undefined)
    .map((k) => ({ metric: k, limit: b[k]!, actual: actual[k], ok: actual[k] <= b[k]! }));
  const p = o.previous;
  let delta: PerfResult["delta"];
  let regressed = false;
  if (p) {
    delta = {
      frameP50: round(summary.frame.p50 - p.frame.p50),
      frameP95: round(summary.frame.p95 - p.frame.p95),
      scriptP95: round(summary.script.p95 - p.script.p95),
      calls: round(summary.calls.avg - p.calls.avg, 1),
      triangles: summary.triangles.avg - p.triangles.avg,
      programs: summary.programs - p.programs,
      geometries: summary.geometries - p.geometries,
      textures: summary.textures - p.textures,
      ...(summary.heapMb !== undefined && p.heapMb !== undefined ? { heapMb: round(summary.heapMb - p.heapMb, 1) } : {}),
    };
    const up = (now: number, before: number, share: number, min: number) => now > before * (1 + share) && now - before >= min;
    regressed = up(summary.frame.p95, p.frame.p95, 0.2, 2) || up(summary.calls.avg, p.calls.avg, 0.1, 1) || up(summary.triangles.avg, p.triangles.avg, 0.1, 100);
  }
  const verdict = budgets.some((x) => !x.ok) ? "over budget" : regressed ? "worse than before" : "ok";
  return { ...summary, slowest, budgets, ...(p ? { previous: p, delta } : {}), regressed, verdict, note: TIMING_NOTE };
}

export async function perf(opts: PerfOptions): Promise<PerfResult> {
  const name = opts.name ?? basename(opts.entry ?? "index.html").replace(/\.html?$/, "");
  const seconds = Math.min(Math.max(opts.seconds ?? 5, 0.5), 120);
  const o = await openRunPage(opts);
  const file = perfFile(o.stateDir, name);
  let frames: FrameRecord[] = [];
  let heapMb: number | undefined;
  try {
    if (o.loaded) {
      await o.page.waitForTimeout(opts.wait ?? 1000);
      const steps = await runSteps(o, opts.steps ?? []);
      if (steps.every((s) => s.ok)) {
        await o.page.waitForTimeout(opts.warmupMs ?? 500);
        await o.page.evaluate("window.__tsRun.rec = []");
        await o.page.waitForTimeout(seconds * 1000);
        frames = (await o.page.evaluate("(() => { const r = window.__tsRun.rec || []; window.__tsRun.rec = null; return r; })()")) as FrameRecord[];
        try {
          const cdp = await o.cdp();
          const heap = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
          heapMb = round(heap.usedSize / 1048576, 1);
        } catch {
          heapMb = undefined; // not Chromium's CDP (a remote browser): no heap number
        }
      }
    }
  } finally {
    await o.close();
  }
  let previous: PerfSummary | undefined;
  if (opts.save !== false) {
    try {
      previous = JSON.parse(readFileSync(file, "utf8")) as PerfSummary;
    } catch {
      previous = undefined; // first run with this name
    }
  }
  const s = summarize(frames, { ...(opts.budget ? { budget: opts.budget } : {}), ...(previous ? { previous } : {}), ...(heapMb !== undefined ? { heapMb } : {}) });
  if (o.loaded && !frames.length && !o.issues.some((i) => i.kind === "step-failed")) {
    o.issues.push({ kind: "no-frames", severity: "warn", message: "No animation frame ran while measuring: the page renders on demand (no requestAnimationFrame / setAnimationLoop loop), so there is nothing to time. Add a step that makes it render, or measure with a loop." });
  }
  let saved = false;
  if (opts.save !== false && frames.length) {
    const keep: PerfSummary = { date: s.date, frames: s.frames, frame: s.frame, script: s.script, calls: s.calls, triangles: s.triangles, programs: s.programs, geometries: s.geometries, textures: s.textures, ...(s.heapMb !== undefined ? { heapMb: s.heapMb } : {}) };
    (opts.write ?? defaultWriter)(file, `${JSON.stringify(keep, null, 2)}\n`);
    saved = true;
  }
  const ok = !o.issues.some((i) => i.severity === "error") && s.budgets.every((b) => b.ok) && frames.length > 0;
  return { ...s, ok, url: o.url, name, seconds, file, saved, issues: o.issues };
}

const fmt = (s: Stats) => `p50 ${s.p50}  p95 ${s.p95}  p99 ${s.p99}  max ${s.max}`;

export function formatPerf(r: PerfResult): string {
  const out = [`Threesmith perf: ${r.ok ? r.verdict.toUpperCase() : "FAIL"} – ${r.url} (${r.name}, ${r.frames} frames in ${r.seconds}s)`];
  out.push(`frame ms   ${fmt(r.frame)}   (${r.frame.p50 ? Math.round(1000 / r.frame.p50) : 0} fps median)`);
  out.push(`script ms  ${fmt(r.script)}   (JS inside requestAnimationFrame)`);
  out.push(`draw calls avg ${r.calls.avg} max ${r.calls.max} · triangles avg ${r.triangles.avg} max ${r.triangles.max} · programs ${r.programs} · geometries ${r.geometries} · textures ${r.textures}${r.heapMb !== undefined ? ` · JS heap ${r.heapMb} MB` : ""}`);
  if (r.slowest.length) {
    out.push("slowest frames:");
    for (const f of r.slowest) out.push(`  frame ${f.frame} @${f.t}ms: ${f.ms} ms (script ${f.scriptMs} ms, ${f.calls} calls): ${f.cause}`);
  }
  for (const b of r.budgets) out.push(`${b.ok ? "ok  " : "OVER"} budget ${b.metric} ${b.actual} (limit ${b.limit})`);
  if (r.previous && r.delta) {
    const d = r.delta;
    out.push(
      `vs last run (${r.previous.date.slice(0, 16).replace("T", " ")}): frame p50 ${signed(d.frameP50 ?? 0)} ms, p95 ${signed(d.frameP95 ?? 0)} ms, script p95 ${signed(d.scriptP95 ?? 0)} ms, calls ${signed(d.calls ?? 0)}, triangles ${signed(d.triangles ?? 0)}, programs ${signed(d.programs ?? 0)}, geometries ${signed(d.geometries ?? 0)}, textures ${signed(d.textures ?? 0)}${d.heapMb !== undefined ? `, heap ${signed(d.heapMb)} MB` : ""}${r.regressed ? "  WORSE" : ""}`,
    );
  } else if (r.saved) out.push("no earlier run with this name: this one is the baseline for the next");
  out.push(...formatIssues(r.issues));
  out.push(`note: ${r.note}`);
  return out.join("\n");
}
