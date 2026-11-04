import type { ReviewResult } from "./review.js";
import type { Finding } from "./types.js";

/** One finding per line, the way agents read best: `file:line severity [rule] message Fix: ...`. */
export function formatFinding(f: Finding, withFix = true): string {
  return `${f.file}:${f.line} ${f.severity} [${f.rule}] ${f.message}${withFix ? ` Fix: ${f.fix}` : ""}`;
}

export interface CompactOptions {
  limit?: number;
  /** Leave out info findings (cheap profile). */
  noInfos?: boolean;
  /** Only findings in these files (paths relative to the reviewed folder). */
  focus?: string[];
  /** Only the summary and the category scores. */
  headerOnly?: boolean;
}

/** The review for an agent: one summary line, the category scores, then one line per finding. */
export function formatCompact(r: ReviewResult, opts: CompactOptions = {}): string {
  if (r.score === null) return `No three.js code found in ${r.path} (${r.filesScanned} files scanned).`;
  const v = r.three ? `three r${r.three.release}` : "three not installed (checked against the newest known API)";
  const out = [
    `review ${r.score}/100 (${r.grade}), ${v}: ${r.threeFiles} three.js file(s), ${r.counts.error} error(s), ${r.counts.warn} warning(s), ${r.counts.info} note(s)`,
    r.categories.map((c) => `${c.category} ${c.score}`).join(" · "),
  ];
  if (opts.headerOnly) return out.join("\n");
  const list = r.findings.filter((f) => (!opts.noInfos || f.severity !== "info") && (!opts.focus?.length || opts.focus.includes(f.file)));
  const limit = opts.limit ?? 40;
  for (const f of list.slice(0, limit)) out.push(formatFinding(f));
  if (list.length > limit) out.push(`+${list.length - limit} more (limit, files, or detail full)`);
  const hiddenInfos = opts.noInfos ? r.findings.filter((f) => f.severity === "info").length : 0;
  if (hiddenInfos) out.push(`${hiddenInfos} note(s) not shown (detail full shows them)`);
  if (!r.findings.length) out.push("no findings");
  return out.join("\n");
}
