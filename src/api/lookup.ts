import { firstSentence } from "./jsdoc.js";
import type { ApiIndex } from "./index-builder.js";
import type { ApiEntry, Member } from "./types.js";

export function levenshtein(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0] ?? 0;
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min((prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
      rowMin = Math.min(rowMin, prev[j] ?? 0);
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length] ?? max + 1;
}

/** Closest public symbol names, for "did you mean". */
export function suggest(index: ApiIndex, name: string, limit = 3): string[] {
  const lower = name.toLowerCase();
  const scored: { n: string; d: number }[] = [];
  for (const n of index.exports.keys()) {
    const d = levenshtein(lower, n.toLowerCase(), 3);
    if (d <= 3 && (d <= Math.max(1, Math.floor(name.length / 4)) || n.toLowerCase().includes(lower))) scored.push({ n, d });
  }
  return scored.sort((a, b) => a.d - b.d || a.n.length - b.n.length).slice(0, limit).map((s) => s.n);
}

export function hasSymbol(index: ApiIndex, name: string): boolean {
  return index.exports.has(name);
}

export interface Resolved {
  entry: ApiEntry;
  /** Own members first, then inherited, with `from` set. */
  members: Member[];
  chain: string[];
}

export function resolve(index: ApiIndex, name: string): Resolved | undefined {
  const entry = index.getEntry(name);
  if (!entry) return undefined;
  const members: Member[] = entry.members.map((m) => ({ ...m, from: entry.name }));
  const chain = [entry.name];
  const seen = new Set(chain);
  let parent = entry.extends;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const p = index.getEntry(parent);
    if (!p) break;
    chain.push(p.name);
    const have = new Set(members.map((m) => m.name));
    for (const m of p.members) if (!have.has(m.name)) members.push({ ...m, from: p.name });
    parent = p.extends;
  }
  return { entry, members, chain };
}

export interface LookupResult {
  found: boolean;
  text: string;
}

function importLine(e: ApiEntry): string {
  return `import { ${e.name} } from '${e.importPath}';`;
}

function fmtMember(m: Member): string {
  const dep = m.deprecated ? ` **deprecated** (${m.deprecated})` : "";
  if (m.kind === "property") {
    return `- \`${m.name}\`${m.type ? `: ${m.type}` : ""}${m.default ? ` = ${m.default}` : ""}${dep} – ${firstSentence(m.description, 140)}`;
  }
  const ret = m.returns ? ` → ${m.returns}` : "";
  return `- \`${m.signature}\`${ret}${dep} – ${firstSentence(m.description, 140)}`;
}

/**
 * Look up "Mesh", "Mesh.raycast", "THREE.Mesh" or "Mesh#raycast" in the index.
 * Output is markdown meant for an agent: exact, short, and pinned to the installed version.
 */
export function lookup(index: ApiIndex, query: string, opts: { inherited?: boolean; full?: boolean } = {}): LookupResult {
  const q = query.trim().replace(/^THREE\./, "");
  const [clsName = "", memberName] = q.split(/[.#]/);
  const header = `three r${index.install.release} (${index.install.version})`;
  const r = resolve(index, clsName);
  if (!r) {
    const s = suggest(index, clsName);
    return {
      found: false,
      text: `\`${clsName}\` is not exported by ${header}.${s.length ? ` Did you mean: ${s.map((x) => `\`${x}\``).join(", ")}?` : ""}`,
    };
  }
  const e = r.entry;
  if (memberName) {
    const hits = r.members.filter((m) => m.name === memberName);
    if (!hits.length) {
      const names = r.members.map((m) => m.name);
      const near = names.filter((n) => levenshtein(n.toLowerCase(), memberName.toLowerCase(), 2) <= 2).slice(0, 3);
      return {
        found: false,
        text: `\`${e.name}\` has no documented member \`${memberName}\` in ${header}.${near.length ? ` Did you mean: ${near.map((x) => `\`${x}\``).join(", ")}?` : ""}`,
      };
    }
    const lines = [`# ${e.name}.${memberName} (${header})`, ""];
    for (const m of hits) {
      lines.push(`\`${m.signature}\`${m.from && m.from !== e.name ? ` – inherited from ${m.from}` : ""}`);
      if (m.deprecated) lines.push(`**Deprecated:** ${m.deprecated}`);
      if (m.description) lines.push("", m.description);
      for (const p of m.params) lines.push(`- \`${p.name}\`: ${p.type}${p.optional ? " (optional)" : ""} – ${p.description}`);
      if (m.returns) lines.push(`- returns: ${m.returns}`);
      if (m.type) lines.push(`- type: ${m.type}`);
      if (m.default) lines.push(`- default: ${m.default}`);
      lines.push("");
    }
    return { found: true, text: lines.join("\n").trimEnd() };
  }
  const lines = [`# ${e.name} (${header})`, "", "```js", importLine(e), "```", ""];
  if (e.deprecated) lines.push(`**Deprecated:** ${e.deprecated}`, "");
  if (e.kind === "constant") {
    lines.push(`Constant: \`${e.value ?? ""}\``);
    if (e.description) lines.push("", e.description);
    return { found: true, text: lines.join("\n").trimEnd() };
  }
  if (e.kind === "function") {
    lines.push(e.description);
    for (const p of e.constructorParams) lines.push(`- \`${p.name}\`: ${p.type}${p.optional ? " (optional)" : ""} – ${p.description}`);
    return { found: true, text: lines.join("\n").trimEnd() };
  }
  if (r.chain.length > 1) lines.push(`Extends: ${r.chain.slice(1).join(" → ")}`, "");
  lines.push(opts.full ? e.description : firstSentence(e.description, 400), "");
  if (e.constructorParams.length) {
    lines.push("## Constructor", "", `\`new ${e.name}( ${e.constructorParams.map((p) => (p.optional ? `${p.name}?` : p.name)).join(", ")} )\``);
    for (const p of e.constructorParams) lines.push(`- \`${p.name}\`: ${p.type}${p.optional ? " (optional)" : ""} – ${firstSentence(p.description, 140)}`);
    lines.push("");
  }
  const own = r.members.filter((m) => m.from === e.name && m.name !== "constructor");
  const inherited = r.members.filter((m) => m.from !== e.name);
  const props = own.filter((m) => m.kind === "property");
  const methods = own.filter((m) => m.kind !== "property");
  if (props.length) lines.push("## Properties", "", ...props.map(fmtMember), "");
  if (methods.length) lines.push("## Methods", "", ...methods.map(fmtMember), "");
  if (inherited.length) {
    if (opts.inherited) lines.push("## Inherited", "", ...inherited.map((m) => `${fmtMember(m)} (from ${m.from})`), "");
    else lines.push(`${inherited.length} inherited members hidden; look up \`${e.name}.<member>\` or pass inherited.`, "");
  }
  return { found: true, text: lines.join("\n").trimEnd() };
}

export interface SearchHit {
  name: string;
  kind: string;
  importPath: string;
  summary: string;
  member?: string;
}

export function search(index: ApiIndex, query: string, opts: { members?: boolean; limit?: number } = {}): SearchHit[] {
  const q = query.trim().replace(/^THREE\./, "").toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? 15;
  const scored: { hit: SearchHit; score: number }[] = [];
  for (const [name, ref] of index.exports) {
    const n = name.toLowerCase();
    let score = 0;
    if (n === q) score = 100;
    else if (n.startsWith(q)) score = 70;
    else if (n.includes(q)) score = 45;
    else if (q.length >= 4 && levenshtein(n, q, 2) <= 2) score = 25;
    if (!score) continue;
    const e = index.getEntry(name);
    scored.push({
      score: score - (index.webgpuOnly.has(name) ? 1 : 0),
      hit: { name, kind: e?.kind ?? "symbol", importPath: ref.importPath, summary: firstSentence(e?.description ?? "", 120) },
    });
  }
  if (opts.members) {
    for (const e of index.allEntries()) {
      for (const m of e.members) {
        if (m.name.toLowerCase() === q || (q.length >= 3 && m.name.toLowerCase().includes(q))) {
          scored.push({
            score: m.name.toLowerCase() === q ? 60 : 30,
            hit: { name: e.name, kind: m.kind, importPath: e.importPath, summary: firstSentence(m.description, 120), member: m.name },
          });
        }
      }
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.hit.name.length - b.hit.name.length)
    .slice(0, limit)
    .map((s) => s.hit);
}

export function formatSearch(index: ApiIndex, hits: SearchHit[]): string {
  const header = `three r${index.install.release}`;
  if (!hits.length) return `No match in ${header}.`;
  return [
    `# Matches in ${header}`,
    "",
    ...hits.map((h) => `- \`${h.name}${h.member ? "." + h.member : ""}\` (${h.kind}, \`${h.importPath}\`) – ${h.summary}`),
  ].join("\n");
}
