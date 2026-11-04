import type { Page } from "playwright-core";
import type { Step } from "./check.js";

/**
 * Steps for play, perf, leaks and scenarios: check's steps plus
 * `frames` (wait n animation frames), `hold` (keep a key down for ms), `eval` (run code in the page, with
 * scene/renderer/camera/$/$$ in scope) and `until` (wait until an expression is true).
 */
export type PlayStep =
  | Step
  | { type: "frames"; n: number }
  | { type: "hold"; key: string; ms: number }
  | { type: "eval"; js: string }
  | { type: "until"; js: string; timeout?: number };

const FIELDS: Record<string, [string, "number" | "string" | "point"][]> = {
  wait: [["ms", "number"]],
  click: [],
  press: [["key", "string"]],
  drag: [["from", "point"], ["to", "point"]],
  wheel: [["deltaY", "number"]],
  "wait-for": [["selector", "string"]],
  frames: [["n", "number"]],
  hold: [["key", "string"], ["ms", "number"]],
  eval: [["js", "string"]],
  until: [["js", "string"]],
};

export const STEP_TYPES = Object.keys(FIELDS);

/** Checks steps given as JSON text or as parsed data; throws with the step number and what is wrong. */
export function parsePlaySteps(input: string | unknown): PlayStep[] {
  const data = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!Array.isArray(data)) throw new Error("steps must be a JSON array");
  data.forEach((s: unknown, i) => {
    const o = s as Record<string, unknown> | null;
    const fields = o && typeof o === "object" ? FIELDS[String(o["type"])] : undefined;
    if (!o || !fields) throw new Error(`step ${i + 1}: unknown step ${JSON.stringify(s)}; types: ${STEP_TYPES.join(", ")}`);
    for (const [name, kind] of fields) {
      const v = o[name];
      const ok = kind === "point" ? Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number") : typeof v === kind;
      if (!ok) throw new Error(`step ${i + 1} (${String(o["type"])}): "${name}" must be ${kind === "point" ? "[x, y]" : `a ${kind}`}`);
    }
    if (o["type"] === "click" && typeof o["selector"] !== "string" && !(typeof o["x"] === "number" && typeof o["y"] === "number")) {
      throw new Error(`step ${i + 1} (click): give a "selector" or "x" and "y"`);
    }
  });
  return data as PlayStep[];
}

/** A step in one short line: "press g", "eval app.load()", "until $('door').visible". */
export function stepLabel(s: PlayStep): string {
  const key = (k: string) => (k === " " ? "Space" : k);
  const short = (t: string) => (t.length > 60 ? `${t.slice(0, 57)}...` : t).replace(/\s+/g, " ");
  switch (s.type) {
    case "wait": return `wait ${s.ms}ms`;
    case "click": return s.selector ? `click ${s.selector}` : `click ${s.x ?? 0},${s.y ?? 0}`;
    case "press": return `press ${key(s.key)}`;
    case "drag": return `drag ${s.from.join(",")} -> ${s.to.join(",")}`;
    case "wheel": return `wheel ${s.deltaY}`;
    case "wait-for": return `wait-for ${s.selector}`;
    case "frames": return `frames ${s.n}`;
    case "hold": return `hold ${key(s.key)} ${s.ms}ms`;
    case "eval": return `eval ${short(s.js)}`;
    case "until": return `until ${short(s.js)}`;
  }
}

const MAX_MS = 60_000;

/** Waits n animation frames; resolves after `fallbackMs` per frame too, so a page without a loop does not hang. */
export async function waitFrames(page: Page, n: number): Promise<void> {
  const count = Math.max(1, Math.min(Math.round(n), 10_000));
  await page.evaluate(
    `new Promise((ok) => { let left = ${count}; const until = performance.now() + ${Math.min(count * 200, MAX_MS)};
      const next = () => { if (--left <= 0 || performance.now() > until) ok(); else go(); };
      const go = () => { let done = false; const once = () => { if (!done) { done = true; next(); } }; requestAnimationFrame(once); setTimeout(once, 200); };
      go(); })`,
  );
}

/** Runs one step. Throws with a short reason when it fails. Returns the value an eval step gave, as JSON. */
export async function runStep(page: Page, step: PlayStep): Promise<unknown> {
  switch (step.type) {
    case "wait":
      await page.waitForTimeout(Math.min(step.ms, MAX_MS));
      return undefined;
    case "click":
      if (step.selector) await page.click(step.selector, { timeout: 5000 });
      else await page.mouse.click(step.x ?? 0, step.y ?? 0);
      return undefined;
    case "press":
      await page.keyboard.press(step.key);
      return undefined;
    case "drag":
      await page.mouse.move(step.from[0], step.from[1]);
      await page.mouse.down();
      await page.mouse.move(step.to[0], step.to[1], { steps: 12 });
      await page.mouse.up();
      return undefined;
    case "wheel":
      await page.mouse.wheel(0, step.deltaY);
      return undefined;
    case "wait-for":
      await page.waitForSelector(step.selector, { timeout: step.timeout ?? 5000 });
      return undefined;
    case "frames":
      await waitFrames(page, step.n);
      return undefined;
    case "hold":
      await page.keyboard.down(step.key);
      try {
        await page.waitForTimeout(Math.min(step.ms, MAX_MS));
      } finally {
        await page.keyboard.up(step.key);
      }
      return undefined;
    case "eval": {
      const r = (await page.evaluate(
        `(async () => { try { return { v: window.__threesmith.value(await window.__threesmith.call(${JSON.stringify(step.js)})) }; } catch (e) { return { e: String((e && e.stack) || e).split('\\n').slice(0, 3).join(' | ') }; } })()`,
      )) as { v?: unknown; e?: string };
      if (r.e !== undefined) throw new Error(`threw ${r.e}`);
      return r.v;
    }
    case "until": {
      const timeout = Math.min(step.timeout ?? 5000, MAX_MS);
      const r = (await page.evaluate(
        `new Promise((ok) => { const t = window.__threesmith; const end = performance.now() + ${timeout}; let last;
          const test = () => { const x = t.read(${JSON.stringify(step.js)}); last = x; if (x.v !== undefined && x.v !== false && x.v !== null && x.v !== 0 && x.v !== '' && x.v !== 'undefined') return ok({ ok: true }); if (performance.now() > end) return ok({ ok: false, last }); let done = false; const once = () => { if (!done) { done = true; test(); } }; requestAnimationFrame(once); setTimeout(once, 50); };
          test(); })`,
      )) as { ok: boolean; last?: { v?: unknown; e?: string } };
      if (!r.ok) {
        const last = r.last?.e !== undefined ? `threw ${r.last.e}` : `last value ${JSON.stringify(r.last?.v)}`;
        throw new Error(`still not true after ${timeout} ms (${last})`);
      }
      return undefined;
    }
  }
}
