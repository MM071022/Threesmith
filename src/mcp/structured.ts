/**
 * Structured results (MCP `structuredContent`) for the tools that report findings: one compact item shape for the
 * review, the headless check and the doctor, capped like the text next to it. Clients that only read text get the
 * same information in the text.
 */
import { z } from "zod";
import type { CheckResult } from "../check/check.js";
import type { Triage } from "../doctor/triage.js";
import type { ReviewResult } from "../review/review.js";
import type { Finding } from "../review/types.js";

const item = z.object({
  file: z.string().optional(),
  line: z.number().optional(),
  severity: z.enum(["error", "warn", "info"]),
  rule: z.string().optional(),
  message: z.string(),
  fix: z.string().optional(),
  count: z.number().optional(),
});
export type Item = z.infer<typeof item>;

const common = {
  ok: z.boolean(),
  errors: z.number(),
  warnings: z.number(),
  findings: z.array(item),
  /** Findings left out by the cap. */
  truncated: z.number(),
};

export const ReviewOutput = {
  ...common,
  score: z.number().nullable(),
  grade: z.string().nullable(),
  three: z.string().nullable(),
  categories: z.record(z.string(), z.number()),
};

export const CheckOutput = {
  ...common,
  url: z.string(),
  frames: z.number(),
  threeRevision: z.string().nullable(),
  contexts: z.array(z.string()),
  baseline: z.string().optional(),
  screenshot: z.string().optional(),
};

export const DoctorOutput = {
  ...common,
  score: z.number().nullable(),
  three: z.string(),
  next: z.array(z.string()),
};

const strip = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const fromFinding = (f: Finding, withFix: boolean): Item => strip({ file: f.file, line: f.line, severity: f.severity, rule: f.rule, message: f.message, ...(withFix ? { fix: f.fix } : {}) });

export function reviewData(r: ReviewResult, cap: number, withFix = true) {
  return {
    ok: r.counts.error === 0,
    errors: r.counts.error,
    warnings: r.counts.warn,
    findings: r.findings.slice(0, cap).map((f) => fromFinding(f, withFix)),
    truncated: Math.max(0, r.findings.length - cap),
    score: r.score,
    grade: r.grade,
    three: r.three ? `r${r.three.release}` : null,
    categories: Object.fromEntries(r.categories.map((c) => [c.category, c.score])),
  };
}

export function checkData(r: CheckResult, cap: number) {
  const findings = r.issues.slice(0, cap).map((i) => strip({ severity: i.severity, rule: i.kind, message: i.message, ...(i.explanations?.[0] ? { fix: i.explanations[0].fix } : {}) }) as Item);
  return {
    ok: r.ok,
    errors: r.issues.filter((i) => i.severity === "error").length,
    warnings: r.issues.filter((i) => i.severity === "warn").length,
    findings,
    truncated: Math.max(0, r.issues.length - cap),
    url: r.url,
    frames: r.stats.frames,
    threeRevision: r.stats.threeRevision,
    contexts: r.stats.contexts,
    ...(r.baseline ? { baseline: r.baseline.status } : {}),
    ...(r.screenshot ? { screenshot: r.screenshot } : {}),
  };
}

export function doctorData(t: Triage, cap: number) {
  const findings: Item[] = [];
  for (const g of t.groups) for (const i of g.items) findings.push(strip({ severity: g.severity, rule: i.rule, message: i.message, fix: i.fix, count: i.count, ...(i.where[0] ? { file: i.where[0].split(":")[0], line: Number(i.where[0].split(":")[1]) || undefined } : {}) }));
  return {
    ok: t.ok,
    errors: t.counts.error,
    warnings: t.counts.warn,
    findings: findings.slice(0, cap),
    truncated: Math.max(0, findings.length - cap),
    score: t.score,
    three: t.three,
    next: t.next,
  };
}
