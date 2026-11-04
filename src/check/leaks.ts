import type { Issue } from "./check.js";
import { openRunPage, runSteps, type StepResult } from "./play.js";
import type { PageOptions } from "./page.js";
import { SNAPSHOT_EVAL, type MemorySnapshot } from "./runtime.js";
import { waitFrames, type PlayStep } from "./steps.js";
import { formatIssues, round, signed } from "./util.js";

/**
 * Finds leaks the way they hurt a long session: runs a cycle of steps (open and close a level, load and unload a
 * model) several times, collects garbage after each cycle, and records what the page still holds: GPU geometries,
 * textures and shader programs (renderer.info), scene objects by type, scenes still reachable, the JS heap, and every
 * geometry/texture/material/render target that reached the GPU and was never disposed, by type. What grows every
 * cycle is the leak.
 */

export interface LeakBudget {
  /** Allowed growth per cycle. Default 0 for all but the heap, which is only judged with a budget (it is noisy). */
  geometries?: number;
  textures?: number;
  programs?: number;
  objects?: number;
  scenes?: number;
  /** Geometries, textures, materials and render targets that reached the GPU and were never disposed. */
  undisposed?: number;
  heapKb?: number;
}

export interface LeakOptions extends PageOptions {
  /** Milliseconds to let the scene start. Default 1000. */
  wait?: number;
  /** Steps run once before the cycles. */
  setup?: PlayStep[];
  /** The steps of one cycle, e.g. [{type:"eval",js:"app.load()"},{type:"frames",n:5},{type:"eval",js:"app.unload()"}]. */
  cycle: PlayStep[];
  /** Cycles to run. Default 5. */
  cycles?: number;
  /** First cycles not counted (caches and first loads fill them). Default 1. */
  warmupCycles?: number;
  budget?: LeakBudget;
}

/** How a count moves over the counted cycles. */
export interface Trend {
  first: number;
  last: number;
  /** Least-squares growth per cycle. */
  perCycle: number;
  /** Grows in at least half the steps and never drops: a leak, not noise or a cache that filled once. */
  growing: boolean;
  values: number[];
}

export type LeakMetric = "geometries" | "textures" | "programs" | "objects" | "scenes" | "undisposed" | "unreachable" | "heapKb";

export interface LeakGroup {
  /** undisposed: on the GPU and never disposed; scene: objects in the scene graph. */
  kind: "undisposed" | "scene";
  type: string;
  perCycle: number;
  last: number;
}

export interface LeakResult {
  ok: boolean;
  url: string;
  cycles: number;
  warmupCycles: number;
  /** Cycles that ran to the end. */
  completed: number;
  metrics: Partial<Record<LeakMetric, Trend>>;
  /** Types that grow per cycle, largest first. */
  growing: LeakGroup[];
  /** Metrics over their budget. */
  over: { metric: LeakMetric; perCycle: number; budget: number }[];
  verdict: "ok" | "leaking";
  hints: string[];
  /** Before the first cycle, then after each. */
  snapshots: MemorySnapshot[];
  /** Steps that failed (all steps would be long). */
  failed: StepResult[];
  issues: Issue[];
}

export function trend(values: number[]): Trend {
  const n = values.length;
  const first = values[0] ?? 0;
  const last = values.at(-1) ?? 0;
  if (n < 2) return { first, last, perCycle: 0, growing: false, values };
  const mx = (n - 1) / 2;
  const my = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  let ups = 0;
  let downs = 0;
  for (let i = 1; i < n; i++) {
    if (values[i]! > values[i - 1]!) ups++;
    if (values[i]! < values[i - 1]!) downs++;
  }
  return { first, last, perCycle: round(num / den), growing: last > first && downs === 0 && ups * 2 >= n - 1, values };
}

const DEFAULT_BUDGET: Required<Omit<LeakBudget, "heapKb">> = { geometries: 0, textures: 0, programs: 0, objects: 0, scenes: 0, undisposed: 0 };

/** Snapshots into trends, groups, verdict and hints: the pure part of leaks, tested without a browser. */
export function judgeLeaks(snapshots: MemorySnapshot[], o: { warmupCycles?: number; budget?: LeakBudget } = {}): Pick<LeakResult, "metrics" | "growing" | "over" | "verdict" | "hints"> {
  // snapshots[0] is before the first cycle; count from the end of the warm-up cycles
  const counted = snapshots.slice(Math.min(1 + (o.warmupCycles ?? 1), Math.max(snapshots.length - 2, 0)));
  const pick = (f: (s: MemorySnapshot) => number | undefined) => counted.map(f).filter((v): v is number => v !== undefined);
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  const metrics: LeakResult["metrics"] = {
    geometries: trend(pick((s) => s.geometries)),
    textures: trend(pick((s) => s.textures)),
    programs: trend(pick((s) => s.programs)),
    objects: trend(pick((s) => s.objects)),
    scenes: trend(pick((s) => s.scenes)),
    undisposed: trend(pick((s) => sum(s.undisposed))),
    unreachable: trend(pick((s) => s.unreachable)),
  };
  const heap = pick((s) => (s.heap !== undefined ? Math.round(s.heap / 1024) : undefined));
  if (heap.length === counted.length && heap.length) metrics.heapKb = trend(heap);
  const growing: LeakGroup[] = [];
  for (const kind of ["undisposed", "scene"] as const) {
    const get = (s: MemorySnapshot) => (kind === "undisposed" ? s.undisposed : s.byType);
    const types = new Set(counted.flatMap((s) => Object.keys(get(s))));
    for (const type of types) {
      const t = trend(counted.map((s) => get(s)[type] ?? 0));
      if (t.growing && t.perCycle > 0) growing.push({ kind, type, perCycle: t.perCycle, last: t.last });
    }
  }
  growing.sort((a, b) => b.perCycle - a.perCycle || a.type.localeCompare(b.type));
  const budget = { ...DEFAULT_BUDGET, ...o.budget };
  const over: LeakResult["over"] = [];
  for (const [metric, limit] of Object.entries(budget) as [LeakMetric, number | undefined][]) {
    const t = metrics[metric];
    if (limit !== undefined && t && t.growing && t.perCycle > limit) over.push({ metric, perCycle: t.perCycle, budget: limit });
  }
  const g = (m: LeakMetric) => !!metrics[m]?.growing && (metrics[m]?.perCycle ?? 0) > 0;
  const hints: string[] = [];
  if ((g("geometries") || g("textures") || g("undisposed")) && !g("objects")) {
    hints.push("Objects leave the scene but their GPU resources stay: call geometry.dispose(), material.dispose() and texture.dispose() for what you remove (traverse the removed root), or reuse them across cycles.");
  }
  if (g("objects")) hints.push("Scene objects pile up every cycle: the unload step does not remove what the load step added (scene.remove(levelRoot)), or something re-adds it.");
  if (g("programs")) hints.push("A new shader program is compiled every cycle: materials with new settings (or onBeforeCompile with a changing key) are made per cycle. Reuse materials, or dispose them so their program is released.");
  if (g("scenes")) hints.push("Old scenes stay reachable after garbage collection: something keeps them (an array, an event listener, a closure, a controls or mixer object). Drop the reference on unload.");
  if (g("unreachable")) hints.push("Some never-disposed resources can no longer be reached from JS: their GPU memory is lost until the page reloads. Dispose them before dropping the last reference.");
  if (g("heapKb") && (metrics.heapKb?.perCycle ?? 0) > 64) hints.push(`The JS heap grows about ${metrics.heapKb?.perCycle} KB per cycle after garbage collection: listeners, caches or arrays keep old objects.`);
  return { metrics, growing: growing.slice(0, 12), over, verdict: over.length ? "leaking" : "ok", hints };
}

export async function leaks(opts: LeakOptions): Promise<LeakResult> {
  const cycles = Math.min(Math.max(Math.round(opts.cycles ?? 5), 2), 200);
  const warmupCycles = Math.min(Math.max(Math.round(opts.warmupCycles ?? 1), 0), cycles - 2);
  if (!opts.cycle?.length) throw new Error("leaks needs the steps of one cycle");
  const o = await openRunPage(opts);
  const snapshots: MemorySnapshot[] = [];
  const failed: StepResult[] = [];
  let completed = 0;
  try {
    if (o.loaded) {
      await o.page.waitForTimeout(opts.wait ?? 1000);
      const cdp = await o.cdp().catch(() => undefined);
      const snap = async () => {
        await waitFrames(o.page, 2); // let deferred work and the last render happen
        if (cdp) {
          await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
          await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
        }
        const s = (await o.page.evaluate(SNAPSHOT_EVAL)) as MemorySnapshot;
        if (cdp) {
          const heap = (await cdp.send("Runtime.getHeapUsage").catch(() => undefined)) as { usedSize: number } | undefined;
          if (heap) s.heap = heap.usedSize;
        }
        snapshots.push(s);
      };
      const setup = await runSteps(o, opts.setup ?? []);
      failed.push(...setup.filter((s) => !s.ok));
      if (!failed.length) {
        await snap();
        for (let c = 0; c < cycles; c++) {
          const steps = await runSteps(o, opts.cycle, { offset: c * opts.cycle.length });
          const bad = steps.filter((s) => !s.ok);
          if (bad.length) {
            failed.push(...bad);
            break;
          }
          completed++;
          await snap();
        }
      }
    }
  } finally {
    await o.close();
  }
  const judged = judgeLeaks(snapshots, { warmupCycles, ...(opts.budget ? { budget: opts.budget } : {}) });
  if (o.loaded && snapshots.length && !snapshots.some((s) => s.objects > 0)) {
    o.issues.push({ kind: "scene", severity: "warn", message: "No three.js scene was announced on the page: only renderer counts were measured (three loaded as a module on this page announces its scenes)." });
  }
  const ok = !o.issues.some((i) => i.severity === "error") && judged.verdict === "ok" && completed === cycles;
  return { ok, url: o.url, cycles, warmupCycles, completed, ...judged, snapshots, failed, issues: o.issues };
}

const per = (t: Trend | undefined) => (t ? `${signed(t.perCycle)}${t.growing && t.perCycle > 0 ? " GROWING" : ""} (${t.first} -> ${t.last})` : "?");

export function formatLeaks(r: LeakResult): string {
  const out = [`Threesmith leaks: ${r.ok ? "OK" : r.verdict === "leaking" ? "LEAKING" : "FAIL"} – ${r.url} (${r.completed} of ${r.cycles} cycles, counted from cycle ${r.warmupCycles + 1}, after garbage collection)`];
  const m = r.metrics;
  out.push(`per cycle: geometries ${per(m.geometries)}, textures ${per(m.textures)}, programs ${per(m.programs)}`);
  out.push(`           scene objects ${per(m.objects)}, scenes alive ${per(m.scenes)}, never disposed ${per(m.undisposed)}${m.unreachable && m.unreachable.last ? `, unreachable ${per(m.unreachable)}` : ""}${m.heapKb ? `, JS heap KB ${per(m.heapKb)}` : ""}`);
  const undisposed = r.growing.filter((g) => g.kind === "undisposed");
  if (undisposed.length) {
    out.push("on the GPU and never disposed (dispose() was not called):");
    for (const g of undisposed) out.push(`  ${signed(g.perCycle)}/cycle ${g.type} (${g.last} now)`);
  }
  const scene = r.growing.filter((g) => g.kind === "scene");
  if (scene.length) {
    out.push("piling up in the scene graph:");
    for (const g of scene) out.push(`  ${signed(g.perCycle)}/cycle ${g.type} (${g.last} now)`);
  }
  for (const x of r.over) out.push(`OVER budget ${x.metric}: ${signed(x.perCycle)} per cycle (allowed ${x.budget})`);
  for (const s of r.failed) out.push(`✖ step ${s.n} (${s.label}) failed: ${s.error}`);
  for (const h of r.hints) out.push(`fix: ${h}`);
  out.push(...formatIssues(r.issues.filter((i) => i.kind !== "step-failed")));
  return out.join("\n");
}
