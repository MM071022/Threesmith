import { statSync } from "node:fs";
import { buildIndex } from "../api/index-builder.js";
import { findThree } from "../api/install.js";
import { collect, lineOf, lineText } from "./source.js";
import { RULES } from "./rules.js";
import type { Category, Ctx, Finding, Rule, Severity } from "./types.js";

export interface ReviewOptions {
  /** Directory or single file to review. */
  path: string;
  /** Package dir of three to pin against (default: node_modules/three above path). */
  three?: string;
  /** Rule ids to skip. */
  disable?: string[];
}

export interface CategoryScore {
  category: Category;
  score: number;
  weight: number;
  findings: number;
}

export interface ReviewResult {
  path: string;
  three: { version: string; release: number } | null;
  filesScanned: number;
  threeFiles: number;
  score: number | null;
  grade: string | null;
  categories: CategoryScore[];
  findings: Finding[];
  counts: Record<Severity, number>;
}

export const CATEGORY_WEIGHTS: Record<Category, number> = {
  correctness: 35,
  api: 25,
  performance: 15,
  lifecycle: 15,
  color: 10,
};

const PENALTY: Record<Severity, number> = { error: 18, warn: 7, info: 1 };

export function gradeOf(score: number): string {
  return score >= 95 ? "A+" : score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 55 ? "D" : "F";
}

function severityFor(rule: Rule, release: number): Severity {
  if (rule.removedIn !== undefined && release >= rule.removedIn) return "error";
  return rule.severity;
}

/** Penalty of a rule grows with repeats, but a rule that fires 20 times is not 20 times worse. */
export function penaltyOf(severity: Severity, count: number): number {
  return PENALTY[severity] * (1 + 0.5 * (Math.min(count, 5) - 1));
}

export function score(findings: Finding[]): { total: number; categories: CategoryScore[] } {
  const cats = (Object.keys(CATEGORY_WEIGHTS) as Category[]).map((category) => {
    const mine = findings.filter((f) => f.category === category);
    const byRule = new Map<string, Finding[]>();
    for (const f of mine) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
    let penalty = 0;
    for (const list of byRule.values()) penalty += penaltyOf(list[0]?.severity ?? "info", list.length);
    return { category, score: Math.max(0, Math.round(100 - penalty)), weight: CATEGORY_WEIGHTS[category], findings: mine.length };
  });
  const totalWeight = cats.reduce((a, c) => a + c.weight, 0);
  const total = Math.round(cats.reduce((a, c) => a + c.score * c.weight, 0) / totalWeight);
  return { total, categories: cats };
}

export function review(opts: ReviewOptions): ReviewResult {
  const root = opts.path;
  const isDir = statSync(root).isDirectory();
  const install = findThree(isDir ? root : root + "/..", opts.three);
  const index = install ? buildIndex(install) : undefined;
  const collected = collect(root);
  const three = collected.files.filter((f) => f.usesThree);
  const ctx: Ctx = {
    files: collected.files,
    three,
    ...(install ? { install } : {}),
    ...(index ? { index } : {}),
    release: install?.release ?? Number.POSITIVE_INFINITY,
    ...(collected.packageJson ? { packageJson: collected.packageJson } : {}),
    all: three.map((f) => f.text).join("\n"),
  };
  const findings: Finding[] = [];
  const disabled = new Set(opts.disable ?? []);
  if (three.length) {
    for (const rule of RULES) {
      if (disabled.has(rule.id)) continue;
      if (rule.introducedIn !== undefined && ctx.release < rule.introducedIn) continue;
      const seen = new Set<string>();
      rule.check(ctx, (file, offset, extra) => {
        const line = lineOf(file.text, offset);
        const key = `${file.path}:${line}`;
        if (seen.has(key)) return;
        seen.add(key);
        findings.push({
          rule: rule.id,
          category: rule.category,
          severity: extra?.severity ?? severityFor(rule, ctx.release),
          file: file.path,
          line,
          message: extra?.message ?? rule.message,
          fix: extra?.fix ?? rule.fix,
          snippet: lineText(file.raw, line),
        });
      });
    }
  }
  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const s = three.length ? score(findings) : undefined;
  return {
    path: root,
    three: install ? { version: install.version, release: install.release } : null,
    filesScanned: collected.files.length,
    threeFiles: three.length,
    score: s ? s.total : null,
    grade: s ? gradeOf(s.total) : null,
    categories: s ? s.categories : [],
    findings,
    counts,
  };
}
