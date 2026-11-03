import type { ReviewResult } from "./review.js";

const ICON = { error: "✖", warn: "▲", info: "·" } as const;

export function formatText(r: ReviewResult, opts: { limit?: number } = {}): string {
  const out: string[] = [];
  const v = r.three ? `three r${r.three.release} (${r.three.version})` : "three not installed – checked against the newest known API";
  if (r.score === null) return `No three.js code found in ${r.path} (${r.filesScanned} files scanned).`;
  out.push(`Threesmith review: ${r.score}/100 (${r.grade}) – ${v}`);
  out.push(`${r.threeFiles} three.js files, ${r.counts.error} errors, ${r.counts.warn} warnings, ${r.counts.info} notes`);
  out.push(r.categories.map((c) => `${c.category} ${c.score}`).join(" · "));
  const shown = r.findings.slice(0, opts.limit ?? 50);
  for (const f of shown) {
    out.push("", `${ICON[f.severity]} ${f.file}:${f.line}  [${f.rule}]`, `  ${f.message}`, `  fix: ${f.fix}`);
  }
  if (r.findings.length > shown.length) out.push("", `… and ${r.findings.length - shown.length} more (use --json or --limit).`);
  return out.join("\n");
}

export function formatMarkdown(r: ReviewResult, opts: { limit?: number } = {}): string {
  if (r.score === null) return `**Threesmith review:** no three.js code found (${r.filesScanned} files scanned).`;
  const v = r.three ? `three r${r.three.release}` : "newest API (three not installed)";
  const out = [
    `### Threesmith review: ${r.score}/100 (${r.grade})`,
    "",
    `Checked against ${v}. ${r.threeFiles} three.js files · ${r.counts.error} errors · ${r.counts.warn} warnings · ${r.counts.info} notes.`,
    "",
    "| Category | Score |",
    "| --- | ---: |",
    ...r.categories.map((c) => `| ${c.category} | ${c.score} |`),
  ];
  const shown = r.findings.slice(0, opts.limit ?? 25);
  if (shown.length) {
    out.push("", "| | Where | Rule | Fix |", "| --- | --- | --- | --- |");
    for (const f of shown) {
      out.push(`| ${ICON[f.severity]} | \`${f.file}:${f.line}\` | \`${f.rule}\` | ${f.fix.replace(/\|/g, "\\|")} |`);
    }
    if (r.findings.length > shown.length) out.push("", `_…and ${r.findings.length - shown.length} more._`);
  }
  return out.join("\n");
}
