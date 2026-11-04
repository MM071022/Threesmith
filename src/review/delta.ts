import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDir, stateDir } from "../project/journal.js";
import type { ReviewResult } from "./review.js";
import type { Finding } from "./types.js";

/**
 * What changed since the previous review of the same project, so an agent in a fix loop reads the new findings in
 * full and the ones it already saw as one short line. The memory is .threesmith/review-last.json (git-ignored).
 */
export interface ReviewDelta {
  fresh: Finding[];
  open: Finding[];
  fixed: number;
  previous: number;
  first: boolean;
}

/** A finding without its line number, so an edit above it does not make it "new". */
const keyOf = (f: Finding): string => `${f.file}|${f.rule}|${f.snippet}`;

export function reviewDelta(root: string, r: ReviewResult, opts: { remember?: boolean } = {}): ReviewDelta {
  const file = join(stateDir(root), "review-last.json");
  let before: string[] | undefined;
  {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { keys?: unknown };
      if (Array.isArray(data.keys)) before = data.keys.filter((k): k is string => typeof k === "string");
    } catch {
      before = undefined;
    }
  }
  const now = r.findings.map(keyOf);
  if (opts.remember !== false) {
    try {
      ensureStateDir(root);
      writeFileSync(file, JSON.stringify({ keys: now }) + "\n");
    } catch {
      /* a read-only project is reviewed all the same */
    }
  }
  if (!before) return { fresh: r.findings, open: [], fixed: 0, previous: 0, first: true };
  const seen = new Set(before);
  const current = new Set(now);
  return {
    fresh: r.findings.filter((f) => !seen.has(keyOf(f))),
    open: r.findings.filter((f) => seen.has(keyOf(f))),
    fixed: before.filter((k) => !current.has(k)).length,
    previous: before.length,
    first: false,
  };
}

export function forgetReview(root: string): void {
  rmSync(join(stateDir(root), "review-last.json"), { force: true });
}

const full = (f: Finding): string => `${f.file}:${f.line} ${f.severity} [${f.rule}] ${f.message} Fix: ${f.fix}`;

export function formatDelta(d: ReviewDelta, opts: { cap?: number } = {}): string {
  const out: string[] = [];
  if (d.first) out.push("first review of this project: every finding is new (next time only_new shows only what changed)");
  else out.push(`since the last review: ${d.fresh.length} new, ${d.fixed} fixed, ${d.open.length} still open`);
  const cap = opts.cap ?? 40;
  if (d.fresh.length) {
    out.push("new:");
    for (const f of d.fresh.slice(0, cap)) out.push(`  ${full(f)}`);
    if (d.fresh.length > cap) out.push(`  +${d.fresh.length - cap} more`);
  }
  if (d.open.length && !d.first) {
    out.push("still open (as reported before):");
    for (const f of d.open.slice(0, cap)) out.push(`  ${f.file}:${f.line} ${f.severity} [${f.rule}]`);
    if (d.open.length > cap) out.push(`  +${d.open.length - cap} more`);
  }
  if (!d.fresh.length && !d.open.length) out.push("no findings");
  return out.join("\n");
}
