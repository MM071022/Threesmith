import type { Param } from "./types.js";

export interface DocBlock {
  description: string;
  params: Param[];
  returns?: string;
  type?: string;
  default?: string;
  deprecated?: string;
  augments?: string;
}

/** Parse the text of a JSDoc comment (without the slash-star markers). */
export function parseDoc(raw: string): DocBlock {
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^\s*\*? ?/, "").trimEnd());
  const desc: string[] = [];
  const tags: string[] = [];
  let inTags = false;
  for (const line of lines) {
    if (line.startsWith("@")) inTags = true;
    if (inTags) {
      if (line.startsWith("@")) tags.push(line);
      else if (tags.length) tags[tags.length - 1] += " " + line.trim();
    } else desc.push(line);
  }
  const out: DocBlock = { description: collapse(desc.join("\n")), params: [] };
  for (const tag of tags) {
    const t = /^@(\w+)\s*(.*)$/s.exec(tag);
    if (!t) continue;
    const name = t[1];
    const rest = (t[2] ?? "").trim();
    if (name === "param") {
      const p = /^\{([^}]*)\}\s+(\[[^\]]+\]|\S+)\s*(?:-\s*)?(.*)$/s.exec(rest);
      if (!p) continue;
      const rawName = p[2] ?? "";
      const optional = rawName.startsWith("[");
      out.params.push({
        name: rawName.replace(/^\[|\]$/g, "").split("=")[0] ?? rawName,
        type: p[1] ?? "",
        optional,
        description: (p[3] ?? "").trim(),
      });
    } else if (name === "return" || name === "returns") {
      const r = /^\{([^}]*)\}\s*(.*)$/s.exec(rest);
      out.returns = r ? r[1] : rest;
    } else if (name === "type") {
      out.type = rest.replace(/^\{|\}$/g, "");
    } else if (name === "default") {
      out.default = rest;
    } else if (name === "deprecated") {
      out.deprecated = rest || "deprecated";
    } else if (name === "augments" || name === "extends") {
      out.augments = rest;
    }
  }
  return out;
}

function collapse(s: string): string {
  return s
    .replace(/\{@link\s+([^}\s]+)(?:\s+[^}]*)?\}/g, (_m, t: string) => t.replace("#", "."))
    .replace(/```[\s\S]*?```/g, "").replace(/\n{2,}/g, "\n\n").trim();
}

export function firstSentence(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  const out = m?.[1] ?? flat;
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}
