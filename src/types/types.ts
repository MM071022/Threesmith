import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ApiIndex } from "../api/index-builder.js";
import { levenshtein, resolve as resolveClass, suggest } from "../api/lookup.js";

/**
 * The type checker's view of a TypeScript project, made useful for three.js: runs the project's own `tsc --noEmit`,
 * keeps the errors (all of them, or only those about three), and gives each three.js error the exact answer from the
 * installed release: the member that does exist ("did you mean"), the right import path for a name three does not
 * export, and a note when @types/three and three disagree (the type error is then about the wrong version).
 */

export interface TypeError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
  /** About three.js (a three type, module or member). */
  three: boolean;
  /** What the installed three says about it. */
  hint?: string;
}

export interface TypesResult {
  ran: boolean;
  /** Why it did not run (no TypeScript, no tsconfig). */
  reason?: string;
  tsc?: string;
  errors: TypeError[];
  /** Errors that are not about three (counted, listed only with all: true). */
  other: number;
  exitCode: number | null;
  /** The command's own last lines when it failed without parseable errors. */
  tail?: string;
}

export type Runner = (cmd: string, args: string[], cwd: string, timeoutMs: number) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: Runner = (cmd, args, cwd, timeoutMs) => {
  const r = spawnSync(cmd, args, { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, shell: process.platform === "win32" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** `src/a.ts(12,5): error TS2339: Property 'x' does not exist on type 'Mesh'.` (also the `file:line:col - error` form). */
export function parseTsc(out: string, root: string): Omit<TypeError, "three">[] {
  const errors: Omit<TypeError, "three">[] = [];
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(l) ?? /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/.exec(l.replace(/\x1b\[[0-9;]*m/g, ""));
    if (!m) continue;
    let message = m[5] ?? "";
    // continuation lines of a long message are indented
    while (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1] ?? "") && !/^\s+\d+\s/.test(lines[i + 1] ?? "")) message += " " + (lines[++i] ?? "").trim();
    const file = relative(root, resolve(root, m[1] ?? "")).split(sep).join("/");
    errors.push({ file, line: Number(m[2]), col: Number(m[3]), code: m[4] ?? "", message: message.slice(0, 600) });
  }
  return errors;
}

const isThreeType = (index: ApiIndex | undefined, name: string): boolean => !!index && (index.exports.has(name) || !!index.getEntry(name));

/** Explain one tsc error with the installed three, when it is about three. */
export function explainTypeError(e: Omit<TypeError, "three">, index: ApiIndex | undefined): TypeError {
  const msg = e.message;
  // Property 'x' does not exist on type 'Mesh<...>'. Did you mean 'y'?
  const prop = /Property '([\w$]+)' does not exist on type '(?:typeof )?([A-Z][\w$]*)/.exec(msg);
  if (prop && isThreeType(index, prop[2] ?? "")) {
    const [, member = "", cls = ""] = prop;
    const r = index ? resolveClass(index, cls) : undefined;
    const names = r ? [...new Set(r.members.map((m) => m.name))] : [];
    const close = names
      .map((n) => ({ n, d: levenshtein(member.toLowerCase(), n.toLowerCase(), 3) }))
      .filter((x) => x.d <= 3 || x.n.toLowerCase().includes(member.toLowerCase()))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map((x) => x.n);
    const where = r ? `${cls} in three r${index!.install.release} (${r.chain.join(" > ")})` : cls;
    return { ...e, three: true, hint: close.length ? `${where} has ${close.map((c) => `\`${c}\``).join(", ")}; three_api ${cls} lists all members.` : `${where} has no \`${member}\`: it may have been removed or renamed (three_api ${cls}.${member}, three_review).` };
  }
  // Module '"three"' has no exported member 'X'. / Module "three" has no exported member named 'X'
  const mod = /Module ['"]+(three(?:\/[\w/.-]+)?)['"]+ has no exported member(?: named)? '([\w$]+)'/.exec(msg);
  if (mod) {
    const [, from = "", name = ""] = mod;
    const ref = index?.exports.get(name);
    const entry = index?.getEntry(name);
    if (ref || entry) return { ...e, three: true, hint: `\`${name}\` is exported from '${entry?.importPath ?? ref?.importPath}' in three r${index!.install.release}, not from '${from}'.` };
    const near = index ? suggest(index, name) : [];
    return { ...e, three: true, hint: `three r${index?.install.release ?? "?"} has no \`${name}\`${near.length ? `; did you mean ${near.map((n) => `\`${n}\``).join(", ")}` : ""} (three_api ${name}).` };
  }
  // Cannot find module 'three/examples/jsm/...' or its corresponding type declarations.
  const missing = /Cannot find module '(three[^']*)'/.exec(msg);
  if (missing) {
    const spec = missing[1] ?? "";
    const fix = spec.startsWith("three/examples/js/") ? "examples/js was removed: import from 'three/addons/...'." : spec === "three" ? "install three and @types/three (npm i three && npm i -D @types/three)." : `check the path with three_api (the file name of the addon); 'three/addons/...' needs @types/three of the same release.`;
    return { ...e, three: true, hint: fix };
  }
  // any other error that names a three type ('Mesh', 'Vector3<...>', 'typeof Object3D') or the three module
  const named = [...msg.matchAll(/'(?:typeof )?(?:THREE\.)?([A-Z][\w$]*)/g)].map((m) => m[1] ?? "").filter((n) => isThreeType(index, n));
  return { ...e, three: /['"]three(?:\/[^'"]*)?['"]|@types\/three/.test(msg) || named.length > 0, ...(named[0] ? { hint: `three_api ${named[0]} gives the exact signature in r${index!.install.release}.` } : {}) };
}

export function checkTypes(path: string, opts: { index?: ApiIndex; runner?: Runner; timeoutMs?: number; project?: string } = {}): TypesResult {
  const root = resolve(path);
  const tsconfig = opts.project ?? (existsSync(join(root, "tsconfig.json")) ? "tsconfig.json" : undefined);
  if (!tsconfig) return { ran: false, reason: "no tsconfig.json in the project (this is for TypeScript projects; three_review works for both).", errors: [], other: 0, exitCode: null };
  const local = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (!existsSync(local) && !opts.runner) return { ran: false, reason: "TypeScript is not installed in the project (npm i -D typescript).", errors: [], other: 0, exitCode: null };
  const run = opts.runner ?? defaultRunner;
  const r = run(existsSync(local) ? local : "tsc", ["--noEmit", "--pretty", "false", "-p", tsconfig], root, opts.timeoutMs ?? 180_000);
  const parsed = parseTsc(`${r.stdout}\n${r.stderr}`, root);
  const all = parsed.map((e) => explainTypeError(e, opts.index));
  const errors = all.filter((e) => e.three);
  const tail = !parsed.length && r.status !== 0 ? `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-8).join("\n") : undefined;
  return { ran: true, tsc: existsSync(local) ? relative(root, local) : "tsc", errors: errors.concat(all.filter((e) => !e.three)), other: all.length - errors.length, exitCode: r.status, ...(tail ? { tail } : {}) };
}

export function formatTypes(r: TypesResult, opts: { all?: boolean; limit?: number; typesNote?: string } = {}): string {
  if (!r.ran) return `Type check did not run: ${r.reason}`;
  const three = r.errors.filter((e) => e.three);
  const shown = opts.all ? r.errors : three;
  const out = [`tsc: ${three.length} three.js type error(s), ${r.other} other${r.exitCode === 0 ? " (exit 0)" : ""}`];
  if (opts.typesNote) out.push(`note: ${opts.typesNote}`);
  const limit = opts.limit ?? 30;
  for (const e of shown.slice(0, limit)) out.push(`${e.file}:${e.line}:${e.col} ${e.code} ${e.message}${e.hint ? `\n  three: ${e.hint}` : ""}`);
  if (shown.length > limit) out.push(`+${shown.length - limit} more`);
  if (!opts.all && r.other) out.push(`(${r.other} error(s) not about three: all: true lists them)`);
  if (r.tail) out.push(r.tail);
  return out.join("\n");
}
