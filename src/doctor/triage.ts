import { FIXES } from "../review/fix.js";
import { review, type ReviewResult } from "../review/review.js";
import type { Finding, Severity } from "../review/types.js";
import { applyFeedback } from "../learn/feedback.js";
import { scanProject, type ProjectMap } from "../scan/scan.js";
import type { AssetProblem } from "../scan/assets.js";

/**
 * "What is wrong here, and in which order do I fix it?" in one call: the project map's notes, the asset check and the
 * review, grouped by cause instead of by line, most urgent first, each group with its fix and whether three_fix does it,
 * then numbered next steps. Made for the first call in a project the agent does not know, or when a scene is broken
 * and the agent does not know where to start.
 */

export interface TriageGroup {
  /** Stable id of the cause. */
  id: string;
  title: string;
  severity: Severity;
  /** Why this group comes first. */
  why: string;
  items: { rule: string; count: number; where: string[]; message: string; fix: string; fixable: boolean }[];
}

export interface Triage {
  root: string;
  ok: boolean;
  score: number | null;
  grade: string | null;
  three: string;
  groups: TriageGroup[];
  next: string[];
  counts: Record<Severity, number>;
  map: ProjectMap;
  review: ReviewResult;
}

/** Rules whose findings mean the scene shows nothing (or nothing right). */
const BLANK = new Set([
  "never-renders",
  "renderer-not-attached",
  "no-lights",
  "camera-near-zero",
  "resize-no-projection",
  "webgpu-no-init",
  "shadows-not-enabled",
  "render-args-swapped",
  "add-gltf-result",
  "shader-include-unknown",
  "shader-glsl3-legacy",
  "shader-raw-undeclared",
  "webgpu-glsl-material",
  "node-material-webgl",
  "controls-document",
  "decoder-not-attached",
  "ktx2-no-detect-support",
]);
const SETUP = new Set(["types-mismatch", "cdn-unpinned", "unknown-symbol", "examples-js", "three-src-import", "importmap-missing", "tsl-import-path", "addon-path-extension"]);

const RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
const FIXABLE = new Set(FIXES.map((f) => f.rule));

function groupFindings(findings: Finding[], pick: (f: Finding) => boolean): TriageGroup["items"] {
  const by = new Map<string, Finding[]>();
  for (const f of findings.filter(pick)) by.set(f.rule, [...(by.get(f.rule) ?? []), f]);
  return [...by.entries()]
    .map(([rule, list]) => ({
      rule,
      count: list.length,
      where: list.slice(0, 4).map((f) => `${f.file}:${f.line}`),
      message: list[0]!.message,
      fix: list[0]!.fix,
      fixable: FIXABLE.has(rule),
      sev: list.reduce((a, f) => Math.min(a, RANK[f.severity]), 2),
    }))
    .sort((a, b) => a.sev - b.sev || b.count - a.count)
    .map(({ sev: _s, ...rest }) => rest);
}

function worst(items: { severity?: Severity }[], fallback: Severity): Severity {
  return items.reduce<Severity>((a, i) => (i.severity && RANK[i.severity] < RANK[a] ? i.severity : a), fallback);
}

function assetItems(problems: AssetProblem[]): TriageGroup["items"] {
  const by = new Map<string, AssetProblem[]>();
  for (const p of problems) by.set(p.kind, [...(by.get(p.kind) ?? []), p]);
  return [...by.entries()].map(([kind, list]) => ({
    rule: `asset-${kind}`,
    count: list.length,
    where: list.slice(0, 4).map((p) => `${p.file ?? ""}${p.line ? `:${p.line}` : ""}`),
    message: list[0]!.message,
    fix: list[0]!.fix,
    fixable: false,
  }));
}

export function triage(path: string, opts: { three?: string; disable?: string[] } = {}): Triage {
  const map = scanProject(path);
  const raw = review({ path: map.root, ...(opts.three ? { three: opts.three } : {}), ...(opts.disable ? { disable: opts.disable } : {}) });
  const r = applyFeedback(raw).review;
  const groups: TriageGroup[] = [];
  const add = (g: Omit<TriageGroup, "severity"> & { severity?: Severity }) => {
    if (g.items.length) groups.push({ ...g, severity: g.severity ?? "warn" });
  };

  const setupNotes = map.notes.filter((n) => /not installed|disagree|CDN/.test(n));
  const setup = groupFindings(r.findings, (f) => SETUP.has(f.rule));
  add({
    id: "setup",
    title: "Versions and imports",
    why: "a wrong three version, a missing install or two copies of three make every other answer unreliable",
    items: [...setupNotes.map((n) => ({ rule: "project", count: 1, where: [], message: n, fix: n.split(": ").slice(1).join(": ") || n, fixable: false })), ...setup],
    severity: setupNotes.length || setup.length ? worst(r.findings.filter((f) => SETUP.has(f.rule)), setupNotes.some((n) => /not installed/.test(n)) ? "error" : "warn") : "info",
  });
  const blank = groupFindings(r.findings, (f) => BLANK.has(f.rule));
  add({ id: "blank", title: "Why the scene shows nothing (or nothing right)", why: "nothing else can be judged while the picture is black or empty", items: blank, severity: worst(r.findings.filter((f) => BLANK.has(f.rule)), "warn") });
  const assetErrors = map.assets.problems.filter((p) => p.severity === "error");
  add({ id: "assets", title: "Assets that will not load", why: "a missing or mis-cased file is a 404, which the loader reports as a parse error far from the cause", items: assetItems(assetErrors), severity: assetErrors.length ? "error" : "warn" });
  const removed = r.findings.filter((f) => f.category === "api" && !SETUP.has(f.rule));
  add({ id: "api", title: "Outdated or removed three.js API", why: "removed names throw or silently do nothing in the installed release", items: groupFindings(removed, () => true), severity: worst(removed, "info") });
  const taken = new Set([...SETUP, ...BLANK]);
  for (const [id, title, why, cat] of [
    ["correctness", "Code that runs but does the wrong thing", "these are bugs the user will see", "correctness"],
    ["color", "Colours", "wrong colour spaces make everything look washed out or too dark", "color"],
    ["performance", "Performance", "work per frame and GPU memory decide whether it runs smoothly on a phone", "performance"],
    ["lifecycle", "Resize and cleanup", "leaks and stretched views show up after the first minutes of use", "lifecycle"],
  ] as const) {
    const list = r.findings.filter((f) => f.category === cat && !taken.has(f.rule));
    add({ id, title, why, items: groupFindings(list, () => true), severity: worst(list, "info") });
  }
  const assetRest = map.assets.problems.filter((p) => p.severity !== "error");
  add({ id: "asset-weight", title: "Asset size and leftovers", why: "big textures and unused files slow the first load", items: assetItems(assetRest), severity: worst(assetRest, "info") });
  // other categories a newer review may have (shader, r3f, ...)
  const known = new Set(["api", "correctness", "color", "performance", "lifecycle"]);
  const others = r.findings.filter((f) => !known.has(f.category) && !taken.has(f.rule));
  for (const cat of [...new Set(others.map((f) => f.category))]) {
    const list = others.filter((f) => f.category === cat);
    add({ id: cat, title: cat[0]!.toUpperCase() + cat.slice(1), why: "found by the review", items: groupFindings(list, () => true), severity: worst(list, "info") });
  }
  groups.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

  const counts: Record<Severity, number> = { ...r.counts };
  for (const p of map.assets.problems) counts[p.severity]++;
  const next: string[] = [];
  if (setupNotes.some((n) => /not installed/.test(n))) next.push("Run npm install, then call three_doctor again (api and review need node_modules/three).");
  if (r.findings.some((f) => FIXABLE.has(f.rule))) next.push("Call three_fix (dry run), then three_fix write: true for the mechanical renames.");
  if (assetErrors.length) next.push("Fix the asset paths (three_assets lists every reference and where it was looked for).");
  if (blank.length) next.push("Fix the 'shows nothing' group first, then confirm with three_check (screenshot) or three_inspect (why objects are not visible).");
  const rest = r.findings.filter((f) => f.severity === "error" && !FIXABLE.has(f.rule)).length;
  if (rest) next.push(`Fix the remaining ${rest} error(s) by hand; three_api gives the exact names for the installed release.`);
  if (r.findings.length) next.push("Call three_review with only_new: true after each change, until no errors are left.");
  next.push(map.pages.length ? `Run three_check on the page (${map.pages[0]!.file}) before you call it done.` : "Run three_check on the dev server URL before you call it done.");
  const install = map.three.installed ? `three r${map.three.release}` : "three not installed";
  return {
    root: map.root,
    ok: counts.error === 0,
    score: r.score,
    grade: r.grade,
    three: install,
    groups,
    next,
    counts,
    map,
    review: r,
  };
}

const ICON: Record<Severity, string> = { error: "✖", warn: "▲", info: "·" };

export function formatTriage(t: Triage, opts: { detail?: "brief" | "full"; hints?: (rules: string[]) => string[] } = {}): string {
  const full = opts.detail === "full";
  const out: string[] = [];
  out.push(`Threesmith doctor: ${t.counts.error} error(s), ${t.counts.warn} warning(s)${t.score !== null ? `, review ${t.score}/100 (${t.grade})` : ""}, ${t.three}, ${t.map.stack.bundler}${t.map.stack.framework.length ? ` + ${t.map.stack.framework.join(", ")}` : ""}`);
  if (!t.groups.length) out.push("Nothing to fix found from the files. Run three_check to see the page itself.");
  let n = 0;
  for (const g of t.groups) {
    if (!full && g.severity === "info" && n >= 4) continue;
    n++;
    out.push("", `${n}. ${ICON[g.severity]} ${g.title} (${g.items.reduce((a, i) => a + i.count, 0)}): ${g.why}`);
    for (const i of g.items.slice(0, full ? 30 : 6)) {
      out.push(`   [${i.rule}]${i.count > 1 ? ` x${i.count}` : ""}${i.where.length ? ` ${i.where.join(", ")}${i.count > i.where.length ? ", ..." : ""}` : ""}${i.fixable ? " (three_fix)" : ""}`);
      out.push(`     ${i.message}${full || !i.fixable ? ` Fix: ${i.fix}` : ""}`);
    }
    if (g.items.length > (full ? 30 : 6)) out.push(`   +${g.items.length - (full ? 30 : 6)} more causes`);
    const hints = opts.hints?.(g.items.map((i) => i.rule)) ?? [];
    for (const h of hints.slice(0, 2)) out.push(`   ${h}`);
  }
  out.push("", "Next:");
  t.next.forEach((s, i) => out.push(`  ${i + 1}. ${s}`));
  return out.join("\n");
}
