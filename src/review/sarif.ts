import { RULES } from "./rules.js";
import type { ReviewResult } from "./review.js";
import { VERSION } from "../version.js";

/** The review as SARIF 2.1.0, for GitHub code scanning and other tools that read it. */
export function toSarif(r: ReviewResult, opts: { base?: string } = {}): object {
  const used = [...new Set(r.findings.map((f) => f.rule))];
  const rules = used.map((id) => {
    const rule = RULES.find((x) => x.id === id);
    return {
      id,
      name: id,
      shortDescription: { text: rule?.title ?? id },
      fullDescription: { text: rule?.message ?? id },
      help: { text: rule?.fix ?? "" },
      properties: { category: rule?.category ?? "other" },
    };
  });
  const level = { error: "error", warn: "warning", info: "note" } as const;
  const prefix = opts.base ? opts.base.replace(/\/?$/, "/") : "";
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "Threesmith", version: VERSION, informationUri: "https://github.com/laaielichter/Threesmith", rules } },
        results: r.findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: used.indexOf(f.rule),
          level: level[f.severity],
          message: { text: `${f.message} Fix: ${f.fix}` },
          locations: [{ physicalLocation: { artifactLocation: { uri: prefix + f.file }, region: { startLine: f.line } } }],
        })),
      },
    ],
  };
}
