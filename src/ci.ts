import { check, type CheckOptions, type CheckResult } from "./check/check.js";
import { formatMarkdown } from "./review/format.js";
import { review, type ReviewResult } from "./review/review.js";
import type { Severity } from "./review/types.js";

export interface CiOptions {
  path: string;
  three?: string;
  minScore?: number;
  /** Fail when a finding of this severity or worse exists. Default: error. */
  failOn?: Severity | "none";
  /** Optional browser check. */
  check?: Omit<CheckOptions, "target"> & { target: string };
  disable?: string[];
}

export interface CiResult {
  ok: boolean;
  reasons: string[];
  review: ReviewResult;
  check?: CheckResult;
  markdown: string;
}

const RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export async function ci(opts: CiOptions): Promise<CiResult> {
  const r = review({ path: opts.path, ...(opts.three ? { three: opts.three } : {}), ...(opts.disable ? { disable: opts.disable } : {}) });
  const reasons: string[] = [];
  const failOn = opts.failOn ?? "error";
  if (failOn !== "none" && r.findings.some((f) => RANK[f.severity] <= RANK[failOn])) {
    reasons.push(`review has ${failOn === "error" ? "errors" : `findings at ${failOn} or worse`}`);
  }
  if (opts.minScore !== undefined && r.score !== null && r.score < opts.minScore) {
    reasons.push(`score ${r.score} is below the minimum ${opts.minScore}`);
  }
  let c: CheckResult | undefined;
  if (opts.check) {
    try {
      c = await check(opts.check);
      if (!c.ok) reasons.push("browser check failed");
    } catch (e) {
      reasons.push(`browser check could not run: ${(e as Error).message}`);
    }
  }
  const ok = reasons.length === 0;
  const lines = [`## Threesmith receipt: ${ok ? "✅ pass" : "❌ fail"}`, ""];
  if (reasons.length) lines.push(...reasons.map((x) => `- ${x}`), "");
  lines.push(formatMarkdown(r));
  if (opts.check) {
    lines.push("", "### Headless check");
    if (!c) lines.push("The browser check could not run.");
    else {
      lines.push(
        `${c.ok ? "Passed" : "Failed"}: ${c.stats.canvases} canvas, contexts ${c.stats.contexts.join(", ") || "none"}, ${c.stats.frames} frames, three ${c.stats.threeRevision ? "r" + c.stats.threeRevision : "?"}.`,
      );
      for (const i of c.issues) lines.push(`- ${i.severity === "error" ? "✖" : "▲"} \`${i.kind}\` ${i.message}`);
      if (c.baseline) lines.push(`- baseline \`${c.baseline.name}\`: ${c.baseline.status}${c.baseline.ratio !== undefined ? ` (${(c.baseline.ratio * 100).toFixed(2)}% changed)` : ""}`);
    }
  }
  lines.push("", "<sub>Made by [Threesmith](https://github.com/laaielichter/Threesmith)</sub>");
  return { ok, reasons, review: r, ...(c ? { check: c } : {}), markdown: lines.join("\n") };
}
