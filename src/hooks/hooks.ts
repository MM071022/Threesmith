import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { findThree } from "../api/install.js";
import { review } from "../review/review.js";
import type { Finding } from "../review/types.js";
import { explain } from "../explain/explain.js";
import { applyFeedback } from "../learn/feedback.js";
import { checkAssets } from "../scan/assets.js";
import { scanProject } from "../scan/scan.js";
import { makeSourceFile } from "../review/source.js";
import { lessonHintsForMessages } from "../lessons/hints.js";
import { protectionMessage, protectionOf } from "../project/protect.js";

/**
 * Hooks for coding agents (Claude Code's hook events), so Threesmith is in the agent's loop without the agent having to
 * remember a tool: a three.js file that was just edited is reviewed and its errors go back to the agent; console output
 * with three.js problems gets a pointer; a session does not end quietly while a changed file still has errors; and a
 * session in a three.js project starts with the installed version.
 *
 * Every hook fails open: when anything goes wrong it says nothing, so a hook never stands in the agent's way.
 */

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean;
}

export interface HookOutput {
  decision?: "block";
  reason?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext?: string; permissionDecision?: "deny"; permissionDecisionReason?: string };
}

export const HOOK_EVENTS = ["pre-edit", "post-edit", "post-bash", "stop", "session-start"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Files whose edits are reviewed. */
export const THREE_FILE = /\.(?:js|mjs|cjs|jsx|ts|tsx|html?|vue|svelte)$/;
const MAX_LISTED = 8;

interface SessionState {
  files: Record<string, { root: string; errors: number }>;
  stopAsked?: string;
}

export interface HookContext {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** A folder only this user can use: the system temp folder is shared, so the name carries the user id. */
const defaultStateDir = (): string => join(tmpdir(), `threesmith-hooks-${process.getuid?.() ?? "user"}`);

const stateFile = (context: HookContext, session: string): string =>
  join(context.stateDir ?? defaultStateDir(), `${createHash("sha256").update(session).digest("hex").slice(0, 32)}.json`);

function readState(context: HookContext, session: string | undefined): SessionState {
  if (!session) return { files: {} };
  try {
    const s = JSON.parse(readFileSync(stateFile(context, session), "utf8")) as SessionState;
    return s && typeof s.files === "object" ? s : { files: {} };
  } catch {
    return { files: {} };
  }
}

function writeState(context: HookContext, session: string | undefined, state: SessionState): void {
  if (!session) return;
  try {
    const dir = dirname(stateFile(context, session));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // never write into a folder someone else made (or a link to one) before we did
    const own = lstatSync(dir);
    if (!own.isDirectory() || (process.getuid && own.uid !== process.getuid())) return;
    const old = Date.now() - 2 * 24 * 3600 * 1000;
    for (const name of readdirSync(dir)) {
      try {
        if (statSync(join(dir, name)).mtimeMs < old) rmSync(join(dir, name), { force: true });
      } catch {
        /* another session removed it */
      }
    }
    writeFileSync(stateFile(context, session), JSON.stringify(state), { mode: 0o600 });
  } catch {
    /* state only sharpens the stop hook */
  }
}

/** The nearest folder at or above `dir` with a package.json; otherwise `dir`. */
export function projectRoot(dir: string): string {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, "package.json"))) return d;
    if (dirname(d) === d) return resolve(dir);
  }
}

const line = (f: Finding): string => `  ${f.file}:${f.line} ${f.severity} [${f.rule}] ${f.message} Fix: ${f.fix}`;

function listFindings(findings: Finding[]): string[] {
  const out = findings.slice(0, MAX_LISTED).map(line);
  if (findings.length > MAX_LISTED) out.push(`  ... and ${findings.length - MAX_LISTED} more (three_review shows all)`);
  return out;
}

function editedFile(input: HookInput): string | undefined {
  const raw = input.tool_input?.["file_path"] ?? input.tool_input?.["notebook_path"] ?? input.tool_input?.["path"];
  if (typeof raw !== "string" || !raw) return undefined;
  return isAbsolute(raw) ? raw : resolve(input.cwd ?? process.cwd(), raw);
}

const context_ = (event: string, lines: string[]): HookOutput => ({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join("\n") } });
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function findingsOf(root: string, file: string): Finding[] {
  const rel = relative(root, file).split("\\").join("/");
  return applyFeedback(review({ path: root })).review.findings.filter((f) => f.file === rel);
}

/** Asset paths in one edited file that do not resolve (missing, or only with other capitals). */
function assetProblemsOf(root: string, file: string): string[] {
  try {
    const rel = relative(root, file).split("\\").join("/");
    const r = checkAssets(root, [makeSourceFile(rel, readFileSync(file, "utf8"))]);
    return r.problems.filter((p) => (p.kind === "missing" || p.kind === "case") && p.file === rel).slice(0, 4).map((p) => `  ${p.file}:${p.line} [asset-${p.kind}] ${p.message} Fix: ${p.fix}`);
  } catch {
    return [];
  }
}

/**
 * Before Write, Edit, MultiEdit or NotebookEdit: deny an edit into a protected path (a threesmith.json "protect" list,
 * $THREESMITH_PROTECT or the plugin's protect option) with the reason. Any file type counts; Bash is not parsed.
 */
export function preEdit(input: HookInput, context: HookContext = {}): HookOutput | undefined {
  const file = editedFile(input);
  if (!file) return undefined;
  const p = protectionOf(file, context.env ?? process.env, input.cwd ?? process.cwd());
  if (!p) return undefined;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: protectionMessage(file, p) } };
}

/** After Edit, Write or MultiEdit of a source file that uses three.js: review it, send errors back, mention warnings. */
export function postEdit(input: HookInput, context: HookContext = {}): HookOutput | undefined {
  const file = editedFile(input);
  if (!file || !THREE_FILE.test(file) || file.split(/[\\/]/).includes("node_modules") || !existsSync(file)) return undefined;
  const root = projectRoot(dirname(file));
  const mine = findingsOf(root, file).filter((f) => f.severity !== "info");
  const errors = mine.filter((f) => f.severity === "error");
  const warnings = mine.filter((f) => f.severity === "warn");
  const rel = relative(root, file);
  const assets = assetProblemsOf(root, file);

  const state = readState(context, input.session_id);
  const before = state.files[file]?.errors ?? 0;
  state.files[file] = { root, errors: errors.length };
  writeState(context, input.session_id, state);

  if (errors.length) {
    return {
      decision: "block",
      reason: [
        `Threesmith reviewed ${rel}: ${plural(errors.length, "error")}${warnings.length ? `, ${plural(warnings.length, "warning")}` : ""}. These break or outdate the scene:`,
        ...listFindings([...errors, ...warnings]),
        ...(assets.length ? ["Asset paths that will not load:", ...assets] : []),
        "Next: fix the errors now (look names up with three_api; it reads the installed version). If a finding is a verified false alarm, say so in your answer and go on.",
      ].join("\n"),
    };
  }
  if (warnings.length || assets.length) {
    return context_("PostToolUse", [
      `Threesmith reviewed ${rel}: no errors${warnings.length ? `, ${plural(warnings.length, "warning")}:` : "."}`,
      ...listFindings(warnings),
      ...(assets.length ? ["Asset paths that will not load (a 404 shows up as a parse error in the loader):", ...assets] : []),
      "Next: fix the warnings that touch what you are building now; mention the others to the user when you finish.",
    ]);
  }
  if (before > 0) return context_("PostToolUse", [`Threesmith reviewed ${rel}: the errors are fixed, no warnings.`]);
  return undefined;
}

function outputText(response: unknown): string {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return "";
  const r = response as Record<string, unknown>;
  return [r["stdout"], r["stderr"], r["output"], r["content"]].filter((p): p is string => typeof p === "string").join("\n");
}

/** What a build, dev server or test run prints when three.js code is outdated or imported wrongly. */
export const THREE_MESSAGE =
  /THREE\.\w+:.*(?:deprecated|removed|renamed|no longer)|Multiple instances of Three\.js|does not provide an export named '(?:\w+)'|Failed to resolve import "three\/examples|Cannot find module 'three\/examples|THREE\.\w+ is not a constructor|\w+ is not a constructor.*THREE/i;

/** After a shell command: when its output has three.js problems, point at the tools that explain them. */
export function postBash(input: HookInput): HookOutput | undefined {
  const text = outputText(input.tool_response).slice(-200_000);
  const m = THREE_MESSAGE.exec(text);
  const known = explain(text);
  if (!m && !(known.length && /three/i.test(text))) return undefined;
  const lessons = lessonHintsForMessages([text.slice(-20_000)]);
  return context_("PostToolUse", [
    `Threesmith: the output above has a three.js problem${m ? ` ("${m[0].slice(0, 120)}")` : ""}.`,
    ...known.slice(0, 3).map((e) => `- ${e.title}: ${e.cause} Fix: ${e.fix}`),
    ...lessons.map((l) => `- ${l}`),
    "Next: look names up with three_api (exact API of the installed version); three_explain with the full message, three_inspect when the scene looks wrong.",
  ]);
}

/** Before the agent stops: changed files that still have review errors are named once. */
export function stop(input: HookInput, context: HookContext = {}): HookOutput | undefined {
  if (input.stop_hook_active) return undefined;
  const state = readState(context, input.session_id);
  const open = Object.entries(state.files).filter(([file, s]) => s.errors > 0 && existsSync(file));
  if (!open.length) return undefined;
  const still: Finding[] = [];
  for (const [file, s] of open) {
    const errors = findingsOf(s.root, file).filter((f) => f.severity === "error");
    state.files[file] = { root: s.root, errors: errors.length };
    still.push(...errors);
  }
  const signature = createHash("sha256").update(still.map(line).join("\n")).digest("hex");
  const asked = state.stopAsked === signature;
  if (still.length) state.stopAsked = signature;
  writeState(context, input.session_id, state);
  if (!still.length || asked) return undefined;
  return {
    decision: "block",
    reason: [
      `Threesmith: ${plural(still.length, "review error")} still open in files you changed:`,
      ...listFindings(still),
      "Next: fix them before you finish, or tell the user why they stay.",
    ].join("\n"),
  };
}

/** At the start of a session in a three.js project: which version is installed and how Threesmith works here. */
export function sessionStart(input: HookInput): HookOutput | undefined {
  const root = projectRoot(input.cwd ?? process.cwd());
  const install = findThree(root);
  let declared = false;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: object; devDependencies?: object };
    declared = "three" in { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    /* no package.json */
  }
  if (!install && !declared) return undefined;
  const brief: string[] = [];
  try {
    const m = scanProject(root);
    const s = m.stack;
    brief.push(
      `Stack: ${s.bundler}${s.framework.length ? ` + ${s.framework.join(", ")}` : ""}${s.typescript ? ", TypeScript" : ""}${Object.keys(s.libraries).length ? `; ${Object.keys(s.libraries).slice(0, 6).join(", ")}` : ""}. ${m.files.length} file(s) use three${m.files[0] ? ` (${m.files.slice(0, 4).map((f) => f.file).join(", ")}${m.files.length > 4 ? ", ..." : ""})` : ""}.`,
    );
    for (const n of m.notes.slice(0, 3)) brief.push(`Note: ${n}`);
  } catch {
    /* the brief is a bonus */
  }
  return context_("SessionStart", [
    install
      ? `Threesmith: this project has three r${install.release} (${install.version}) installed.`
      : "Threesmith: this project depends on three, but it is not installed (npm install), so API lookups cannot run yet.",
    ...brief,
    "Every three.js file you edit is reviewed right after the edit; errors come back to you. Next: three_api before you use an API you are not sure of (three changes monthly; never write it from memory), three_review when you finish, three_check to open the page headless and look at the screenshot; three_doctor when something is broken and you do not know where to start.",
  ]);
}

export function runHook(event: HookEvent, input: HookInput, context: HookContext = {}): HookOutput | undefined {
  switch (event) {
    case "pre-edit":
      return preEdit(input, context);
    case "post-edit":
      return postEdit(input, context);
    case "post-bash":
      return postBash(input);
    case "stop":
      return stop(input, context);
    case "session-start":
      return sessionStart(input);
  }
}
