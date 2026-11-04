import type { Issue } from "./check.js";

/** Issues as short lines: severity, kind, message, then shader lines and known causes and fixes. */
export function formatIssues(issues: Issue[]): string[] {
  const out: string[] = [];
  for (const i of issues) {
    out.push(`${i.severity === "error" ? "✖" : "▲"} [${i.kind}] ${i.message}`);
    for (const e of i.shader ?? []) {
      out.push(`    ${e.stage} shader line ${e.line}: ${e.message}${e.code ? `\n      ${e.code}` : ""}${e.source ? `\n      in your code: ${e.source}` : ""}`);
    }
    for (const e of i.explanations ?? []) out.push(`    why: ${e.cause}\n    fix: ${e.fix}${e.detail ? `\n    ${e.detail}` : ""}`);
  }
  return out;
}

/** A name safe as a file name: letters, digits, dot, dash and underscore. */
export function safeName(name: string): string {
  const s = name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(0, 80);
  return s || "default";
}

export const round = (n: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** "+3", "-1.5", "0". */
export const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

/** Writes a file; the lead passes a journal writer instead so the change can be undone. */
export type Writer = (absPath: string, data: string) => void;
