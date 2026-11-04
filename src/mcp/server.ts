import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatSearch, lookup, search } from "../api/lookup.js";
import { check, formatCheck, parseSteps } from "../check/check.js";
import { formatScene } from "../check/inspect.js";
import { explain, formatExplanations } from "../explain/explain.js";
import { indexFor } from "../core.js";
import { fix, formatFix } from "../review/fix.js";
import { review } from "../review/review.js";
import { formatCompact, formatFinding } from "../review/compact.js";
import { formatDelta, reviewDelta } from "../review/delta.js";
import { RULES } from "../review/rules.js";
import { applyFeedback, formatLearned, recordFeedback } from "../learn/feedback.js";
import { formatTriage, triage } from "../doctor/triage.js";
import { formatProjectMap, projectRootOf, scanProject } from "../scan/scan.js";
import { checkAssets, formatAssets } from "../scan/assets.js";
import { collect } from "../review/source.js";
import { formatJournal, formatUndo, readJournal, undoJournal, writeFiles } from "../project/journal.js";
import { checkTypes, formatTypes } from "../types/types.js";
import { formatErrors, listSessions, pageOp, startSession, stopSession, type PageOp } from "../session/session.js";
import { LESSON_TOPICS } from "../lessons/types.js";
import { findLesson, lessonsForError, lessonsForRule, searchLessons, type LessonHit } from "../lessons/search.js";
import { formatLesson, formatLessonList } from "../lessons/format.js";
import { addLocalLesson, recordLessonFeedback, type LessonInput } from "../lessons/local.js";
import { lessonHintsForMessages, lessonHintsForRules } from "../lessons/hints.js";
import type { PageOptions } from "../check/page.js";
import { parsePlaySteps } from "../check/steps.js";
import { formatPlay, play, type PlayOptions } from "../check/play.js";
import { formatScenarios, loadScenarios, runScenarios, saveScenario } from "../check/scenario.js";
import { formatPerf, perf, type PerfBudget } from "../check/perf.js";
import { formatLeaks, leaks, type LeakBudget } from "../check/leaks.js";
import { buildCheck, formatBuild } from "../check/build.js";
import {
  EXAMPLE_SPEC,
  SPEC_CHEAT,
  SPEC_HELP,
  archetypeLibrary,
  briefFor,
  buildModel,
  checkModelSetup,
  formatIdentify,
  formatKinds,
  formatLint,
  formatModelInfo,
  formatModelNeeds,
  formatModelReport,
  formatSetupProblems,
  identify,
  inspectModel,
  lintModelFile,
  modelNeeds,
  recipeSpec,
  viewModel,
} from "../model/index.js";
import { VERSION } from "../version.js";
import { renderInstructions, type Tier } from "./instructions.js";
import { CheckOutput, DoctorOutput, ReviewOutput, checkData, doctorData, reviewData } from "./structured.js";
import { ALL_TOOLS, WRITE_ONLY_TOOLS, enabledTools, readOnlyRefusal } from "./toolsets.js";

export type { Tier } from "./instructions.js";

export interface ServerOptions {
  /** Folder the tools work in when no path is given (default: the working directory). */
  root?: string;
  /** cheap: short output and step-by-step guidance (default). premium: full detail. */
  tier?: Tier;
  /** Tool sets and tool names to offer (see TOOLSETS; default all). */
  tools?: string | readonly string[];
  /** Leave out the tools that always write, and refuse the write options of the others. */
  readOnly?: boolean;
}

interface Profile {
  detail: "brief" | "full";
  findings: number;
  infos: boolean;
}

const PROFILES: Record<Tier, Profile> = {
  cheap: { detail: "brief", findings: 15, infos: false },
  premium: { detail: "full", findings: 200, infos: true },
};

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const failure = (t: string) => text(t, true);
const result = <T extends { ok: boolean }>(t: string, data: T, error = !data.ok, extra: Content[] = []) => ({
  content: [{ type: "text" as const, text: t } as Content, ...extra],
  structuredContent: data as T & Record<string, unknown>,
  ...(error ? { isError: true } : {}),
});

async function guard<T>(fn: () => T | Promise<T>): Promise<T | ReturnType<typeof failure>> {
  try {
    return await fn();
  } catch (e) {
    return failure((e as Error).message);
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function createServer(options: ServerOptions = {}): McpServer {
  const tier: Tier = options.tier ?? "cheap";
  if (!Object.hasOwn(PROFILES, tier)) throw new Error(`tier must be cheap or premium, got "${tier}"`);
  const profile = PROFILES[tier];
  const base = resolve(options.root ?? process.cwd());
  const where = (p?: string): string => (!p ? base : isAbsolute(p) ? p : resolve(base, p));

  const enabled = enabledTools(options.tools);
  if (options.readOnly) for (const n of WRITE_ONLY_TOOLS) enabled.delete(n);
  const server = new McpServer({ name: "threesmith", title: "Threesmith", version: VERSION }, { instructions: renderInstructions(tier, enabled, options.readOnly === true) });

  // Registers a tool only when its set is enabled; a read-only server refuses the options that write.
  const register = server.registerTool.bind(server);
  const tool = ((name: string, config: never, cb: (args: Record<string, unknown>, extra: unknown) => unknown) => {
    if (!ALL_TOOLS.includes(name)) throw new Error(`${name} is in no tool set (src/mcp/toolsets.ts)`);
    if (!enabled.has(name)) return undefined;
    const run = async (args: Record<string, unknown>, extra: unknown) => {
      const why = options.readOnly ? readOnlyRefusal(name, args ?? {}) : undefined;
      if (why) return failure(why);
      return cb(args, extra);
    };
    return register(name, config, run as never);
  }) as typeof server.registerTool;

  const pathParam = z.string().optional().describe("Project folder, or a file or folder in it (relative to the server's folder; default: the project).");
  const threeParam = z.string().optional().describe("Path to a three package folder, when it is not in node_modules above the project.");
  const detailParam = z.enum(["brief", "full"]).optional().describe(`brief (capped, short) or full (everything); default ${profile.detail}`);

  tool(
    "three_doctor",
    {
      title: "What is wrong, and in which order to fix it",
      description:
        "Start here in a three.js project you do not know, or when something is broken and you do not know where to begin. From the files alone (no browser): versions and imports, why the scene shows nothing, assets that will not load, removed APIs for the installed release, colour, performance and cleanup — grouped by cause, most urgent first, each with its fix and whether three_fix does it, then numbered next steps. For the page itself use three_check afterwards. Read-only.",
      inputSchema: { path: pathParam, three: threeParam, detail: detailParam },
      outputSchema: DoctorOutput,
      annotations: READ,
    },
    async ({ path, three, detail }) =>
      guard(() => {
        const t = triage(where(path), { ...(three ? { three } : {}) });
        return result(formatTriage(t, { detail: detail ?? profile.detail, hints: (rules) => lessonHintsForRules(rules).slice(0, 1) }), doctorData(t, profile.findings), false);
      }),
  );

  tool(
    "three_scan",
    {
      title: "Map the three.js project",
      description:
        "Map a three.js project from its files in one call: bundler and framework (Vite, Next, React Three Fiber, plain import map), installed three release vs package.json and @types/three, the libraries around it, pages and how they load three, every file that uses three with what it creates (renderer, cameras, lights, controls, loaders, composer) and where its animation loop is, renderer settings (tone mapping, colour space, shadows, pixel ratio) and the assets the code loads with problems. Call it once before your first edit. `detail` full adds imports per file, every asset problem and the glTF extensions of each model. Read-only.",
      inputSchema: { path: pathParam, detail: detailParam },
      annotations: READ,
    },
    async ({ path, detail }) => guard(() => text(formatProjectMap(scanProject(where(path)), detail ?? profile.detail))),
  );

  tool(
    "three_api",
    {
      title: "three.js API lookup",
      description:
        "Exact API of a three.js class, constant or member, read from the three version installed in the project (not from memory): constructor, properties, methods, deprecations and the right import path ('three' or 'three/addons/...'). Use it before writing or changing three.js code you are not sure about. Query: `Mesh`, `WebGLRenderer.setPixelRatio`, `OrbitControls`. Unknown names get did-you-mean suggestions. Read-only.",
      inputSchema: { query: z.string().describe("Class, Class.member or constant, e.g. WebGLRenderer.setSize"), inherited: z.boolean().optional().describe("also list inherited members"), full: z.boolean().optional().describe("full class description"), path: pathParam, three: threeParam },
      annotations: READ,
    },
    async ({ query, inherited, full, path, three }) =>
      guard(() => {
        const r = lookup(indexFor(where(path), three), query, { ...(inherited ? { inherited } : {}), ...(full || tier === "premium" ? { full: full ?? false } : {}) });
        return text(r.text, !r.found);
      }),
  );

  tool(
    "three_search",
    {
      title: "Search the three.js API",
      description: "Find three.js classes, constants or members by (part of a) name in the installed version, when you do not know the exact name; then call three_api on the best match. `members` also searches method and property names. Read-only.",
      inputSchema: { query: z.string(), members: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional(), path: pathParam, three: threeParam },
      annotations: READ,
    },
    async ({ query, members, limit, path, three }) =>
      guard(() => {
        const index = indexFor(where(path), three);
        return text(formatSearch(index, search(index, query, { ...(members ? { members } : {}), limit: limit ?? (tier === "cheap" ? 10 : 25) })));
      }),
  );

  tool(
    "three_review",
    {
      title: "Review three.js code",
      description:
        "Scored static review (0-100) of the three.js code, pinned to the installed release: removed or renamed APIs, symbols that do not exist, code that renders nothing (no lights, shadows off, renderer not attached, never rendered), per-frame allocations, resize and dispose, colour management. One line per finding, `file:line severity [rule] message Fix: ...`, and the same as JSON. `code` + `file` reviews code before you save it. `only_new: true` in a fix loop: new findings in full, the ones you saw as a short line, and how many are fixed. `files` lists only findings in those files. Run it after every change and fix the errors first. It writes only its memory for only_new (.threesmith/review-last.json).",
      inputSchema: {
        path: pathParam,
        target: z.string().optional().describe("same as path (older name)"),
        code: z.string().optional().describe("unsaved source to review in place of `file` on disk"),
        file: z.string().optional().describe("path (relative to path) that `code` belongs to; required with code"),
        files: z.array(z.string()).optional().describe("only show findings in these files (relative paths)"),
        only_new: z.boolean().optional().describe("show only what changed since the last review (saves tokens in a fix loop)"),
        limit: z.number().int().min(1).max(200).optional(),
        disable: z.array(z.string()).optional().describe("rule ids to skip"),
        three: threeParam,
        detail: detailParam,
      },
      outputSchema: ReviewOutput,
      annotations: WRITES,
    },
    async ({ path, target: older, code, file, files, only_new, limit, disable, three, detail }) =>
      guard(() => {
        if (code !== undefined && !file) return failure("Pass `file` (the path the code belongs to) together with `code`.");
        const target = where(path ?? older);
        const isDir = statSync(target).isDirectory();
        const root = isDir ? target : projectRootOf(target);
        const rel = (p: string) => relative(root, resolve(root, p)).split(sep).join("/");
        const focus = [...(files ?? []).map(rel), ...(file ? [rel(file)] : []), ...(!isDir ? [rel(target)] : [])];
        const raw = review({ path: root, ...(three ? { three } : {}), ...(disable ? { disable } : {}), ...(code !== undefined && file ? { overrides: { [rel(file)]: code } } : {}) });
        const { review: r, learned } = applyFeedback(raw);
        const full = (detail ?? profile.detail) === "full";
        const cap = limit ?? profile.findings;
        let body: string;
        if (only_new) {
          const d = reviewDelta(root, r, { remember: code === undefined });
          const keep = (f: (typeof r.findings)[number]) => (!focus.length || focus.includes(f.file)) && (full || profile.infos || f.severity !== "info");
          body = [formatCompact(r, { headerOnly: true }), formatDelta({ ...d, fresh: d.fresh.filter(keep), open: d.open.filter(keep) }, { cap })].join("\n");
        } else {
          if (code === undefined) reviewDelta(root, r);
          body = formatCompact(r, { limit: cap, noInfos: !(full || profile.infos), focus });
        }
        const hints = lessonHintsForRules([...new Set(r.findings.filter((f) => f.severity !== "info").map((f) => f.rule))]);
        if (hints.length) body += `\n${hints.join("\n")}`;
        const note = formatLearned(learned);
        const shown = focus.length ? { ...r, findings: r.findings.filter((f) => focus.includes(f.file)) } : r;
        return result(note ? `${body}\n${note}` : body, reviewData(shown, cap, full || tier === "premium"), false);
      }),
  );

  tool(
    "three_types",
    {
      title: "Type-check a TypeScript three.js project",
      description:
        "Run the project's own TypeScript (`tsc --noEmit`) and return the type errors about three.js, each with the answer from the installed release: the member that does exist (did you mean), where a name is really exported from ('three' or 'three/addons/...'), removed paths, and a note when @types/three is a different release than three. `all: true` lists the other type errors too. Needs typescript and a tsconfig.json in the project; for JavaScript use three_review. Read-only (tsc runs with --noEmit).",
      inputSchema: { path: pathParam, all: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional(), three: threeParam },
      annotations: READ,
    },
    async ({ path, all, limit, three }) =>
      guard(() => {
        const root = projectRootOf(where(path));
        let index;
        try {
          index = indexFor(root, three);
        } catch {
          index = undefined;
        }
        const note = scanProject(root).notes.find((n) => n.includes("@types/three"));
        const r = checkTypes(root, { ...(index ? { index } : {}) });
        return text(formatTypes(r, { ...(all ? { all } : {}), limit: limit ?? profile.findings * 2, ...(note ? { typesNote: note } : {}) }), r.ran && r.errors.some((e) => e.three));
      }),
  );

  tool(
    "three_fix",
    {
      title: "Apply mechanical three.js fixes",
      description:
        "Apply the review fixes that need no decision: renames with exactly the same meaning (BoxBufferGeometry -> BoxGeometry, THREE.Math -> MathUtils, applyMatrix -> applyMatrix4, three/examples/jsm -> three/addons, outputEncoding/encoding -> colorSpace, merged geometry utils) and a capped pixel ratio. Shows what it would change unless write is true; a write is one undoable step (three_undo). Run three_review afterwards; the rest needs a decision.",
      inputSchema: { path: pathParam, target: z.string().optional().describe("same as path (older name)"), write: z.boolean().optional(), only: z.array(z.string()).optional().describe("rule ids to fix"), rewrites: z.boolean().optional().describe("also apply the rewrites that change more than a name (render argument order, color.set(), the missing .js, TransformControls.getHelper()); the dry run lists them"), three: threeParam },
      annotations: WRITES,
    },
    async ({ path, target: older, write, only, rewrites, three }) =>
      guard(() => {
        const target = where(path ?? older);
        const r = fix({ path: target, ...(three ? { three } : {}), ...(only ? { only } : {}), ...(rewrites ? { rewrites } : {}) });
        if (!write || !r.total) return text(formatFix(r));
        const folder = statSync(target).isDirectory() ? target : join(target, "..");
        const root = projectRootOf(folder);
        const id = writeFiles(
          root,
          "three_fix",
          `${r.total} mechanical fix(es)`,
          r.files.map((f) => ({ file: relative(root, join(folder, f.file)), data: f.fixed })),
        );
        return text(`${formatFix({ ...r, written: true })}\nUndo with three_undo (journal #${id}).`);
      }),
  );

  tool(
    "three_rules",
    {
      title: "List the review rules",
      description: "Every three_review rule with its category, severity, release gating and fix. `query` filters by words in the id or title, `category` by category. Use it to understand a rule id or to pick ids for `disable`. Read-only.",
      inputSchema: { query: z.string().optional(), category: z.string().optional(), detail: detailParam },
      annotations: READ,
    },
    async ({ query, category, detail }) =>
      guard(() => {
        const q = query?.toLowerCase();
        const list = RULES.filter((r) => (!category || r.category === category) && (!q || `${r.id} ${r.title}`.toLowerCase().includes(q)));
        const full = (detail ?? profile.detail) === "full" || list.length <= 8;
        const out = [`${list.length} rule(s)${category ? ` in ${category}` : ""}:`];
        for (const r of list) {
          const gate = [r.introducedIn ? `from r${r.introducedIn}` : "", r.deprecatedIn ? `deprecated r${r.deprecatedIn}` : "", r.removedIn ? `removed r${r.removedIn}` : ""].filter(Boolean).join(", ");
          out.push(`${r.id} (${r.category}, ${r.severity}${gate ? `, ${gate}` : ""}): ${r.title}${full ? `. Fix: ${r.fix}` : ""}`);
        }
        return text(out.join("\n"), list.length === 0);
      }),
  );

  tool(
    "three_feedback",
    {
      title: "Mark a review finding as wrong or right",
      description:
        "Tell Threesmith that a review finding is a false alarm you verified (verdict wrong): it is hidden from later reviews on this machine, and a rule that is often wrong here gets a note. verdict right undoes that and counts the rule as useful. Stores only hashes and counters, never code, names or paths ($THREESMITH_HOME; THREESMITH_LEARN=0 turns learning off).",
      inputSchema: {
        file: z.string().describe("file of the finding (relative to path)"),
        line: z.number().int().min(1),
        rule: z.string().optional().describe("rule id; default: the finding on that line"),
        verdict: z.enum(["wrong", "right"]),
        path: pathParam,
      },
      annotations: WRITES,
    },
    async ({ file, line, rule, verdict, path }) =>
      guard(() => {
        const root = projectRootOf(where(path));
        const rel = relative(root, resolve(root, file)).split(sep).join("/");
        const r = review({ path: root });
        const hit = r.findings.find((f) => f.file === rel && f.line === line && (!rule || f.rule === rule));
        if (!hit) return failure(`No finding${rule ? ` [${rule}]` : ""} at ${rel}:${line} in the current review. Run three_review and pass the file and line it printed.`);
        const c = recordFeedback(hit, verdict);
        return text(`${verdict === "wrong" ? "Hidden from now on" : "Counted as right"}: ${formatFinding(hit, false)}\nrule ${c.rule}: marked wrong ${c.wrong}x, right ${c.right}x on this machine.`);
      }),
  );

  tool(
    "three_undo",
    {
      title: "Undo Threesmith writes",
      description: "Undo the last Threesmith writes in the project (three_fix and other writes), newest first: files are put back as they were, new files removed. A file changed by hand since the write is left alone unless force is true. `list: true` only shows the journal.",
      inputSchema: { path: pathParam, steps: z.number().int().min(1).max(40).optional(), force: z.boolean().optional(), list: z.boolean().optional() },
      annotations: { ...WRITES, destructiveHint: true },
    },
    async ({ path, steps, force, list }) =>
      guard(() => {
        const root = projectRootOf(where(path));
        if (list) return text(formatJournal(readJournal(root)));
        return text(formatUndo(undoJournal(root, { ...(steps ? { steps } : {}), ...(force ? { force } : {}) })));
      }),
  );

  tool(
    "three_assets",
    {
      title: "Check the assets the code loads",
      description:
        "Resolve every model, texture, HDR/EXR, KTX2, sound, font and video path in the code like the dev server and a static host do (public/ served at /, the page's folder, the source file's folder, loader.setPath): missing files (a 404 that GLTFLoader reports as \"Unexpected token '<'\"), paths that only work on a case-insensitive disk (macOS/Windows) and break on Linux hosts, Draco/KTX2 decoder folders that are not there, glTF files using Draco, meshopt or KTX2 when the code never sets that decoder up, textures above 4096, big uncompressed models, and large asset files nothing refers to. Read-only.",
      inputSchema: { path: pathParam, limit: z.number().int().min(1).max(200).optional() },
      annotations: READ,
    },
    async ({ path, limit }) =>
      guard(() => {
        const root = projectRootOf(where(path));
        const r = checkAssets(root, collect(root).files);
        return text(formatAssets(r, { limit: limit ?? (tier === "cheap" ? 20 : 100) }), r.problems.some((p) => p.severity === "error"));
      }),
  );

  const stepSchema = z
    .array(
      z.union([
        z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(30000) }),
        z.object({ type: z.literal("click"), selector: z.string().optional(), x: z.number().optional(), y: z.number().optional() }),
        z.object({ type: z.literal("press"), key: z.string() }),
        z.object({ type: z.literal("drag"), from: z.tuple([z.number(), z.number()]), to: z.tuple([z.number(), z.number()]) }),
        z.object({ type: z.literal("wheel"), deltaY: z.number() }),
        z.object({ type: z.literal("wait-for"), selector: z.string(), timeout: z.number().int().optional() }),
      ]),
    )
    .optional()
    .describe("Interactions before the screenshot: click (selector or x,y), press (key), drag, wheel, wait, wait-for.");
  const targetParam = z.string().describe("Folder with the page (index.html), or the http(s) URL of a running dev server.");

  tool(
    "three_check",
    {
      title: "Run a three.js page headless",
      description:
        "Open the page in headless Chromium (software WebGL 2) and report what a user would see go wrong: console and page errors (each with its likely cause and fix; shader errors point at your file and line), failed requests, no canvas or WebGL context, lost context, blank frames, the three revision, and a screenshot. `baseline` compares with an approved screenshot (created on first run) and reports the changed share with a diff image. `steps` interact first. When the frame is blank it also inspects the scene. Run it before you call a change done.",
      inputSchema: {
        target: targetParam,
        entry: z.string().optional().describe("HTML file in the folder (default index.html)"),
        root: z.string().optional().describe("Folder to serve when the page needs files above its own folder (for example ../node_modules)."),
        wait: z.number().int().min(0).max(30000).optional().describe("Milliseconds to let the scene run (default 2000)."),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        baseline: z.string().optional().describe("Baseline name; created on first run."),
        update_baseline: z.boolean().optional(),
        tolerance: z.number().min(0).max(1).optional(),
        webgpu: z.boolean().optional(),
        inspect: z.boolean().optional().describe("Also read the live scene graph and say why objects are not visible (done anyway when the frame is blank)."),
        steps: stepSchema,
        ignore: z.array(z.string()).optional().describe("console messages containing this text are ignored"),
        screenshot: z.boolean().optional().describe("return the screenshot image (default true)"),
      },
      outputSchema: CheckOutput,
      annotations: { ...WRITES, openWorldHint: true },
    },
    async (a) =>
      guard(async () => {
        const r = await check({
          target: /^https?:/.test(a.target) ? a.target : where(a.target),
          ...(a.entry ? { entry: a.entry } : {}),
          ...(a.root ? { root: where(a.root) } : {}),
          ...(a.wait !== undefined ? { wait: a.wait } : {}),
          ...(a.width ? { width: a.width } : {}),
          ...(a.height ? { height: a.height } : {}),
          ...(a.baseline ? { baseline: a.baseline } : {}),
          ...(a.update_baseline ? { updateBaseline: true } : {}),
          ...(a.tolerance !== undefined ? { tolerance: a.tolerance } : {}),
          ...(a.webgpu ? { webgpu: true } : {}),
          ...(a.inspect ? { inspect: true } : {}),
          ...(a.steps ? { steps: parseSteps(JSON.stringify(a.steps)) } : {}),
          ...(a.ignore ? { ignore: a.ignore } : {}),
        });
        const extra: Content[] = [];
        if (r.screenshot && a.screenshot !== false) extra.push({ type: "image", data: readFileSync(r.screenshot).toString("base64"), mimeType: "image/png" });
        const hints = lessonHintsForMessages(r.issues.filter((i) => i.severity === "error").map((i) => i.detail ?? i.message));
        return result(hints.length ? `${formatCheck(r)}\n${hints.join("\n")}` : formatCheck(r), checkData(r, profile.findings), !r.ok, extra);
      }),
  );

  tool(
    "three_inspect",
    {
      title: "Inspect the live three.js scene",
      description:
        "Open the page headless and read the running scene through three's devtools hook: the scene graph (types, names, positions, geometry, materials, lights), the camera, renderer stats (draw calls, triangles, geometries, textures) and whether GPU memory keeps growing. Diagnoses why objects are not visible: no lights, camera inside or pointed away, behind the camera, beyond far, zero scale, NaN positions, invisible materials, wrong layers, stretched aspect, shadows switched off. Use it when a scene is black, empty or wrong, before guessing.",
      inputSchema: {
        target: targetParam,
        entry: z.string().optional(),
        root: z.string().optional(),
        wait: z.number().int().min(0).max(30000).optional(),
        leak_ms: z.number().int().min(0).max(30000).optional().describe("Sample GPU memory this many ms apart (default 1500, 0 = off)."),
        max_nodes: z.number().int().min(1).max(400).optional(),
        steps: stepSchema,
      },
      annotations: { ...WRITES, openWorldHint: true },
    },
    async (a) =>
      guard(async () => {
        const r = await check({
          target: /^https?:/.test(a.target) ? a.target : where(a.target),
          inspect: true,
          ...(a.entry ? { entry: a.entry } : {}),
          ...(a.root ? { root: where(a.root) } : {}),
          ...(a.wait !== undefined ? { wait: a.wait } : {}),
          ...(a.leak_ms !== undefined ? { leakMs: a.leak_ms } : {}),
          ...(a.steps ? { steps: parseSteps(JSON.stringify(a.steps)) } : {}),
        });
        const problems = r.issues.filter((i) => i.kind !== "scene");
        const parts = [r.scene ? formatScene(r.scene, { maxNodes: a.max_nodes ?? (tier === "cheap" ? 40 : 120) }) : "No scene report."];
        if (problems.length) parts.push("", formatCheck({ ...r, issues: problems, scene: undefined } as typeof r));
        const content: Content[] = [{ type: "text", text: parts.join("\n") }];
        if (r.screenshot) content.push({ type: "image", data: readFileSync(r.screenshot).toString("base64"), mimeType: "image/png" });
        return { content };
      }),
  );

  const playStep = z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      'Steps in order: {"type":"click","selector":"#start"} or {x,y}, {"type":"press","key":"Space"}, {"type":"hold","key":"ArrowRight","ms":300}, {"type":"drag","from":[x,y],"to":[x,y]}, {"type":"wheel","deltaY":200}, {"type":"wait","ms":500}, {"type":"wait-for","selector":"canvas"}, {"type":"frames","n":10}, {"type":"eval","js":"app.start()"}, {"type":"until","js":"$(\'ball\').position.y < 0","timeout":5000}.',
    );
  const pageOpts = (a: { target: string; entry?: string | undefined; root?: string | undefined; width?: number | undefined; height?: number | undefined; webgpu?: boolean | undefined; ignore?: string[] | undefined }): PageOptions => ({
    target: /^https?:/.test(a.target) ? a.target : where(a.target),
    ...(a.entry ? { entry: a.entry } : {}),
    ...(a.root ? { root: where(a.root) } : {}),
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    ...(a.webgpu ? { webgpu: true } : {}),
    ...(a.ignore ? { ignore: a.ignore } : {}),
  });
  const pageParams = {
    target: targetParam,
    entry: z.string().optional(),
    root: z.string().optional().describe("folder to serve when the page needs files above its own folder"),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    webgpu: z.boolean().optional(),
    ignore: z.array(z.string()).optional(),
  };
  /** Writes through the journal, so three_undo can take it back. */
  const journalWriter = (tool: string, summary: string) => (absPath: string, data: string) => {
    const root = projectRootOf(dirname(absPath));
    writeFiles(root, tool, summary, [{ file: relative(root, absPath), data }]);
  };
  const claimParam = z
    .array(z.union([z.string(), z.object({ js: z.string(), at: z.union([z.enum(["end", "any", "always"]), z.number()]).optional() })]))
    .optional()
    .describe('Claims about the scene: "$(\'player\').position.y > 1 @ end", "any: $(\'door\').rotation.y > 1", "always: info.render.calls < 200", "x @ step 2", or {js, at}.');

  tool(
    "three_play",
    {
      title: "Run steps and watch the scene",
      description:
        "Prove that a change does what it should. Open the page headless, run steps (click, press, hold, drag, wheel, wait, frames, eval, until) and read `watch` expressions in the live scene after every frame and step, with `scene`, `camera`, `renderer`, `info` (renderer.info), `$('name')` and `$$('Type')` in scope (window globals such as `app` work too). `expect` claims are judged at the end, at any moment or at every frame, each pass or fail with its value, time, frame and step. Watched values come back only where they changed. Also page and console errors with explanations, and a screenshot. When it passes, keep it with three_scenario op save.",
      inputSchema: {
        ...pageParams,
        wait: z.number().int().min(0).max(30000).optional().describe("ms to let the scene run before the first step (default 1000)"),
        steps: playStep,
        watch: z.array(z.string()).optional().describe("JS expressions to follow, e.g. $('player').position, info.render.calls"),
        expect: claimParam,
        sample_ms: z.number().int().min(16).max(5000).optional(),
        screenshot: z.boolean().optional(),
      },
      annotations: { ...WRITES, openWorldHint: true },
    },
    async (a) =>
      guard(async () => {
        const r = await play({
          ...pageOpts(a),
          ...(a.wait !== undefined ? { wait: a.wait } : {}),
          ...(a.steps ? { steps: parsePlaySteps(a.steps) } : {}),
          ...(a.watch ? { watch: a.watch } : {}),
          ...(a.expect ? { expect: a.expect } : {}),
          ...(a.sample_ms ? { sampleMs: a.sample_ms } : {}),
        });
        const content: Content[] = [{ type: "text", text: formatPlay(r) }];
        if (r.screenshot && a.screenshot !== false && tier === "premium") content.push({ type: "image", data: readFileSync(r.screenshot).toString("base64"), mimeType: "image/png" });
        return { content, ...(r.ok ? {} : { isError: true }) };
      }),
  );

  tool(
    "three_scenario",
    {
      title: "Keep and run regression scenarios",
      description:
        "Regression tests made from three_play runs, kept in the project as .threesmith/scenarios/<name>.json (commit them; threesmith ci runs them and writes JUnit). op save runs the play once more with the same arguments and keeps it only when it passes (undoable with three_undo); op list shows the kept ones; op run runs one (name) or all, with every failing claim, its value and frame.",
      inputSchema: {
        op: z.enum(["save", "list", "run"]),
        name: z.string().optional().describe("scenario name (letters, digits, - and _); for run: exact or part of the name"),
        path: pathParam,
        overwrite: z.boolean().optional(),
        target: targetParam.optional(),
        entry: z.string().optional(),
        root: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        wait: z.number().int().min(0).max(30000).optional(),
        steps: playStep,
        watch: z.array(z.string()).optional(),
        expect: claimParam,
      },
      annotations: { ...WRITES, openWorldHint: true },
    },
    async (a) =>
      guard(async () => {
        const project = projectRootOf(where(a.path ?? (a.target && !/^https?:/.test(a.target) ? a.target : undefined)));
        if (a.op === "list") {
          const list = loadScenarios(project);
          return text(list.length ? list.map((s) => `${s.scenario.name} (${s.file}): ${s.scenario.steps.length} step(s), ${s.scenario.expect.length} claim(s)`).join("\n") : "No scenarios yet. Save a passing three_play run with op save.");
        }
        if (a.op === "run") {
          const rs = await runScenarios(project, { ...(a.name ? { name: a.name } : {}) });
          return text(rs.length ? formatScenarios(rs, { brief: tier === "cheap" }) : "No scenarios to run.", rs.some((r) => !r.ok));
        }
        if (!a.name || !a.target) return failure("op save needs name and target (and the steps, watch and expect of the play run).");
        if (!a.expect?.length) return failure("op save needs at least one expect claim: a scenario without claims proves nothing.");
        const opts: PlayOptions = {
          ...pageOpts({ ...a, target: a.target }),
          ...(a.wait !== undefined ? { wait: a.wait } : {}),
          ...(a.steps ? { steps: parsePlaySteps(a.steps) } : {}),
          ...(a.watch ? { watch: a.watch } : {}),
          expect: a.expect,
        };
        const r = await saveScenario(project, a.name, opts, { write: journalWriter("three_scenario", `save scenario ${a.name}`), ...(a.overwrite ? { overwrite: true } : {}) });
        return text(r.saved ? `saved ${r.file}: it passed (${r.result.claims.length} claim(s)). threesmith ci runs it.` : `not saved: ${r.reason}\n${formatPlay(r.result)}`, !r.saved);
      }),
  );

  tool(
    "three_perf",
    {
      title: "Measure frames, draw calls and GPU resources",
      description:
        "Measure a page for some seconds (after optional steps): draw calls and triangles per frame, shader programs, geometries and textures (exact, the same on every GPU), JS heap, and frame-time percentiles with the slowest frames and their cause (shader compile, GPU upload, draw calls, JS). Checks `budget` and compares with the last run of the same name (kept in .threesmith/perf/). Frame times come from software rendering: use them before/after on the same machine, not as real fps. Measure before and after every performance change.",
      inputSchema: {
        ...pageParams,
        wait: z.number().int().min(0).max(30000).optional(),
        steps: playStep,
        seconds: z.number().min(0.5).max(60).optional().describe("how long to measure (default 5)"),
        budget: z
          .object({ frameMs: z.number().optional(), calls: z.number().optional(), triangles: z.number().optional(), textures: z.number().optional(), geometries: z.number().optional(), programs: z.number().optional() })
          .optional()
          .describe("limits: frameMs (p95), calls and triangles (max per frame), textures, geometries, programs"),
        name: z.string().optional().describe("name of the measurement for the comparison (default: the entry file)"),
        save: z.boolean().optional().describe("keep this run for the next comparison (default true)"),
      },
      annotations: { ...WRITES, openWorldHint: true },
    },
    async (a) =>
      guard(async () => {
        const r = await perf({
          ...pageOpts(a),
          ...(a.wait !== undefined ? { wait: a.wait } : {}),
          ...(a.steps ? { steps: parsePlaySteps(a.steps) } : {}),
          ...(a.seconds ? { seconds: a.seconds } : {}),
          ...(a.budget ? { budget: a.budget as PerfBudget } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(a.save === false || options.readOnly ? { save: false } : {}),
        });
        return text(formatPerf(r), !r.ok);
      }),
  );

  tool(
    "three_leaks",
    {
      title: "Find what grows per cycle",
      description:
        "Repeat a `cycle` of steps (open and close a level, add and remove objects: e.g. {\"type\":\"eval\",\"js\":\"app.load(); app.unload()\"}) several times with garbage collection after each, and report what grows per cycle: GPU geometries, textures and programs, scene objects, scenes still alive, JS heap, and the resources that reached the GPU and were never disposed, by type (SphereGeometry, MeshStandardMaterial, Texture robot.png). Fails over the budget (default: no growth). Run it again after the fix to show 0 per cycle.",
      inputSchema: {
        ...pageParams,
        wait: z.number().int().min(0).max(30000).optional(),
        setup: playStep,
        cycle: z.array(z.record(z.string(), z.unknown())).min(1).describe("the steps of one cycle (same step types as three_play)"),
        cycles: z.number().int().min(2).max(50).optional().describe("default 5"),
        warmup_cycles: z.number().int().min(0).max(10).optional().describe("cycles not counted (default 1)"),
        budget: z
          .object({ geometries: z.number().optional(), textures: z.number().optional(), programs: z.number().optional(), objects: z.number().optional(), scenes: z.number().optional(), undisposed: z.number().optional(), heapKb: z.number().optional() })
          .optional()
          .describe("growth allowed per cycle"),
      },
      annotations: { ...WRITES, openWorldHint: true },
    },
    async (a) =>
      guard(async () => {
        const r = await leaks({
          ...pageOpts(a),
          cycle: parsePlaySteps(a.cycle),
          ...(a.setup ? { setup: parsePlaySteps(a.setup) } : {}),
          ...(a.wait !== undefined ? { wait: a.wait } : {}),
          ...(a.cycles ? { cycles: a.cycles } : {}),
          ...(a.warmup_cycles !== undefined ? { warmupCycles: a.warmup_cycles } : {}),
          ...(a.budget ? { budget: a.budget as LeakBudget } : {}),
        });
        return text(formatLeaks(r), !r.ok);
      }),
  );

  tool(
    "three_build",
    {
      title: "Build and check what will be deployed",
      description:
        "Run the project's own build script (npm/pnpm/yarn/bun run build; this runs the project's code), then check the output folder: how many copies of three are bundled and its size, assets the bundle or a .gltf refers to that are missing or differ in case, root-absolute URLs that break under a sub-path host such as GitHub Pages (with the base to set), Draco/KTX2 decoder files, then open the built page headless (served under its base). `build: false` checks the output that is already there. Use it before you call a page ready to deploy.",
      inputSchema: {
        path: pathParam,
        script: z.string().optional().describe("package.json script (default build)"),
        out_dir: z.string().optional().describe("output folder (default from the bundler config, else dist, build or out)"),
        base: z.string().optional().describe('deploy base, e.g. "/repo/" for GitHub Pages (default from the config)'),
        build: z.boolean().optional().describe("false: do not build, check the existing output"),
        check: z.boolean().optional().describe("false: skip the headless check of the built page"),
        timeout_s: z.number().int().min(10).max(1800).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guard(async () => {
        const r = await buildCheck({
          project: projectRootOf(where(a.path)),
          ...(a.script ? { script: a.script } : {}),
          ...(a.out_dir ? { outDir: a.out_dir } : {}),
          ...(a.base ? { base: a.base } : {}),
          ...(a.build === false ? { run: false as const } : {}),
          ...(a.check === false ? { check: false as const } : {}),
          ...(a.timeout_s ? { timeoutMs: a.timeout_s * 1000 } : {}),
        });
        return text(formatBuild(r), !r.ok);
      }),
  );

  const fileParam = z.string().describe(".glb or .gltf file (relative to the project)");

  tool(
    "three_model_brief",
    {
      title: "One page before you build a model",
      description:
        "Start here before you make a 3D model for a three.js scene: what the thing is (English or Dutch, typos and descriptions work), the nearest ready-made kind to start from, its parts and real size, the rules and usual mistakes, the order of tools and a spec cheat sheet. glTF and three.js agree: +Y up, metres, the model's front is +Z. Read-only.",
      inputSchema: { what: z.string().describe("the thing, e.g. 'fire truck', 'oak tree', 'zeilboot'") },
      annotations: READ,
    },
    async ({ what }) => guard(() => text(briefFor(what).text)),
  );

  tool(
    "three_model_identify",
    {
      title: "What a thing is",
      description:
        "What a thing is, for building or checking a model of it: the family, the parts that must exist and how they move (pivots of wheels, doors, rotors), a typical size with its source, variants, and the usual mistakes. English or Dutch names and descriptions work. Read-only.",
      inputSchema: { what: z.string() },
      annotations: READ,
    },
    async ({ what }) => guard(() => text(formatIdentify(identify(what), archetypeLibrary()))),
  );

  tool(
    "three_model_spec",
    {
      title: "The model spec format and the ready-made kinds",
      description:
        "The JSON model spec that three_model_build reads (a tree of named parts: box, cylinder, ellipsoid, lathe, loft, extrude, roof, tube, with expressions, mirror, repeat, bevels and textured materials), an example, and the ready-made kinds with their parameters. `kind` returns the full spec of one recipe to edit. Read-only.",
      inputSchema: { kind: z.string().optional().describe("a recipe kind: its full spec as JSON"), short: z.boolean().optional().describe("cheat sheet only") },
      annotations: READ,
    },
    async ({ kind, short }) =>
      guard(() => {
        if (kind) return text(JSON.stringify(recipeSpec(kind), null, 1));
        return text(short || tier === "cheap" ? `${SPEC_CHEAT}\n\nKinds:\n${formatKinds()}` : `${SPEC_HELP}\n\nExample:\n${JSON.stringify(EXAMPLE_SPEC, null, 1)}\n\nKinds:\n${formatKinds()}`);
      }),
  );

  tool(
    "three_model_build",
    {
      title: "Build a .glb from a kind or a spec",
      description:
        "Make a clean .glb without Blender: a ready-made `kind` (car, tree, house, boat, aircraft, terrain, ... see three_model_spec) with `params`, or your own `spec`. Deterministic (the same request gives the same bytes), a node per part with UVs and normals, unique node names as GLTFLoader shows them. Writes `out` in the project (undoable with three_undo) and returns the size, triangles and the lint. Look at it with three_model_view afterwards.",
      inputSchema: {
        kind: z.string().optional(),
        spec: z.unknown().optional().describe("a full model spec (JSON object)"),
        params: z.record(z.string(), z.unknown()).optional(),
        seed: z.number().int().optional(),
        textures: z.boolean().optional().describe("false: plain colours instead of texture maps (smaller)"),
        out: z.string().describe("where to write the .glb, e.g. public/models/car.glb"),
        path: pathParam,
      },
      annotations: WRITES,
    },
    async (a) =>
      guard(() => {
        const r = buildModel({
          ...(a.kind ? { kind: a.kind } : {}),
          ...(a.spec !== undefined ? { spec: typeof a.spec === "string" ? JSON.parse(a.spec) : a.spec } : {}),
          ...(a.params ? { params: a.params } : {}),
          ...(a.seed !== undefined ? { seed: a.seed } : {}),
          ...(a.textures === false ? { textures: false } : {}),
        });
        const root = projectRootOf(where(a.path));
        const file = relative(root, resolve(root, a.out));
        if (!file.endsWith(".glb")) return failure("out must end in .glb");
        const id = writeFiles(root, "three_model_build", `build ${r.name}`, [{ file, data: r.glb }]);
        return text(`wrote ${file} (journal #${id}): ${r.summary}\n${formatModelReport(r.report, tier === "premium" ? "full" : "brief")}\nLoad it: (await new GLTFLoader().loadAsync('${file.replace(/^public\//, "/")}')).scene`, r.report.categories.some((c) => c.errors > 0));
      }),
  );

  tool(
    "three_model_view",
    {
      title: "See a model as text",
      description:
        "Draw a .glb as text for agents that cannot see pictures: front, side and top views made of letters (one letter per part), a table of the parts with sizes, and the parts that do not touch the rest (a wheel without an axle, a roof above its house). Use it after every build to check shape, proportions and that everything is attached. Read-only.",
      inputSchema: { file: fileParam, only: z.enum(["front", "side", "top"]).optional(), width: z.number().int().min(20).max(160).optional(), path: pathParam },
      annotations: READ,
    },
    async ({ file, only, width, path }) => guard(() => text(viewModel(resolve(projectRootOf(where(path)), file), { ...(only ? { only } : {}), ...(width ? { width } : {}) }))),
  );

  tool(
    "three_model_lint",
    {
      title: "Score a model for three.js",
      description:
        "Score a .glb or .gltf for the web: geometry (normals, winding, degenerate triangles), materials, performance (triangles, draw calls, texture memory against web budgets), loading (extensions three.js does not support, decoders needed), size and origin; with `archetype` (an id or a name such as 'car' or 'helikopter') also whether it is what it should be: parts, pivots, wheel axes, size, direction. Read-only.",
      inputSchema: {
        file: fileParam,
        archetype: z.string().optional(),
        max_triangles: z.number().int().optional(),
        max_draw_calls: z.number().int().optional(),
        detail: detailParam,
        path: pathParam,
      },
      annotations: READ,
    },
    async (a) =>
      guard(() => {
        const r = lintModelFile(resolve(projectRootOf(where(a.path)), a.file), {
          ...(a.archetype ? { archetype: a.archetype } : {}),
          ...(a.max_triangles ? { maxTriangles: a.max_triangles } : {}),
          ...(a.max_draw_calls ? { maxDrawCalls: a.max_draw_calls } : {}),
        });
        return text(formatLint(r, a.detail ?? profile.detail), r.failed);
      }),
  );

  tool(
    "three_model_inspect",
    {
      title: "What is in a model, and how three.js loads it",
      description:
        "What is in a .glb or .gltf without loading it in a browser: nodes, meshes, triangles, materials, textures with sizes, animations, skins, size in metres, glTF extensions, a draw-call estimate, and which loaders and decoders three.js needs for it (DRACOLoader, MeshoptDecoder, KTX2Loader) with the code to set them up. It also checks the project's code sets those decoders up. Read-only.",
      inputSchema: { file: fileParam, detail: detailParam, path: pathParam },
      annotations: READ,
    },
    async ({ file, detail, path }) =>
      guard(() => {
        const root = projectRootOf(where(path));
        const info = inspectModel(resolve(root, file));
        const problems = checkModelSetup(modelNeeds(info), collect(root).files.filter((f) => f.usesThree || /GLTFLoader|useGLTF/.test(f.text)).map((f) => f.text));
        return text(`${formatModelInfo(info, detail ?? profile.detail)}\n${formatModelNeeds(modelNeeds(info))}${problems.length ? `\n${formatSetupProblems(problems)}` : ""}`, problems.length > 0);
      }),
  );

  tool(
    "three_session",
    {
      title: "Keep a three.js page running between calls",
      description:
        "Start a headless page that stays open between tool calls (op start), so a scene that takes long to load or a state that is hard to reach is loaded once; three_page then looks at it and drives it. op status lists the open pages, op stop closes one. It stops by itself after 10 minutes without calls. Several pages can run side by side under different names (default main).",
      inputSchema: {
        op: z.enum(["start", "stop", "status"]),
        name: z.string().optional().describe("name of the page (default main)"),
        target: targetParam.optional(),
        entry: z.string().optional(),
        root: z.string().optional().describe("folder to serve when the page needs files above its own folder"),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        wait: z.number().int().min(0).max(30000).optional().describe("ms to let the scene run after load (default 1500)"),
        webgpu: z.boolean().optional(),
      },
      annotations: { ...WRITES, openWorldHint: true },
    },
    async (a) =>
      guard(async () => {
        const name = a.name ?? "main";
        if (a.op === "status") {
          const list = listSessions();
          return text(list.length ? list.map((s) => `${s.name}: ${s.url} (${s.minutes} min)`).join("\n") : "No live pages. Start one with op start.");
        }
        if (a.op === "stop") return text((await stopSession(name)) ? `stopped ${name}` : `no live page named ${name}`);
        if (!a.target) return failure("op start needs target (a folder with index.html or a dev server URL).");
        const r = await startSession(
          {
            target: /^https?:/.test(a.target) ? a.target : where(a.target),
            ...(a.entry ? { entry: a.entry } : {}),
            ...(a.root ? { root: where(a.root) } : {}),
            ...(a.width ? { width: a.width } : {}),
            ...(a.height ? { height: a.height } : {}),
            ...(a.wait !== undefined ? { wait: a.wait } : {}),
            ...(a.webgpu ? { webgpu: true } : {}),
          },
          name,
        );
        const lines = [
          `${r.replaced ? "restarted" : "started"} ${r.name}: ${r.url}, three ${r.threeRevision ? `r${r.threeRevision}` : "not seen"}, ${r.canvases} canvas, ${r.frames} render call(s), ${r.objects} object(s) in the scene`,
          "Next: three_page op eval (js with scene, camera, renderer, $('name')), op steps, op frames, op until, op screenshot, op inspect.",
        ];
        const errors = formatErrors(r.errors);
        if (errors) lines.push(errors);
        return text(lines.join("\n"), r.errors.some((e) => e.kind !== "console-warn"));
      }),
  );

  tool(
    "three_page",
    {
      title: "Look at and drive the live page",
      description:
        "Work with the page three_session started, without reloading it. op eval runs JS in the page and returns the value as compact JSON (vectors as [x,y,z], colours as hex, objects as type/name/position), with `scene`, `camera`, `renderer` (the last ones rendered), `$('name')` (getObjectByName), `$$('Type')` and `THREE` (when global) in scope; a single expression is returned, statements need `return`. op steps runs interactions (click, press, drag, wheel, wait, wait-for); op frames waits n animation frames; op until waits until a JS expression is true; op screenshot returns the picture; op inspect reads the scene graph and why objects are not visible; op reload loads edited files (state starts over); op errors lists the errors so far. Every answer ends with the new console and page errors.",
      inputSchema: {
        op: z.enum(["eval", "steps", "frames", "until", "screenshot", "inspect", "reload", "errors"]),
        name: z.string().optional(),
        js: z.string().optional().describe("for eval and until, e.g. $('player').position or scene.children.length"),
        steps: stepSchema,
        n: z.number().int().min(1).max(600).optional().describe("frames to wait"),
        timeout: z.number().int().min(0).max(60000).optional().describe("ms for until (default 5000)"),
        max_nodes: z.number().int().min(1).max(400).optional(),
      },
      annotations: { ...WRITES, openWorldHint: true },
    },
    async (a) =>
      guard(async () => {
        let op: PageOp;
        if (a.op === "eval" || a.op === "until") {
          if (!a.js) return failure(`op ${a.op} needs js.`);
          op = a.op === "eval" ? { op: "eval", js: a.js } : { op: "until", js: a.js, ...(a.timeout !== undefined ? { timeout: a.timeout } : {}) };
        } else if (a.op === "steps") {
          if (!a.steps?.length) return failure("op steps needs steps.");
          op = { op: "steps", steps: parseSteps(JSON.stringify(a.steps)) };
        } else if (a.op === "frames") op = { op: "frames", n: a.n ?? 1 };
        else if (a.op === "inspect") op = { op: "inspect", ...(a.max_nodes ? { maxNodes: a.max_nodes } : {}) };
        else op = { op: a.op };
        const r = await pageOp(op, a.name ?? "main");
        const errors = formatErrors(r.errors);
        const content: Content[] = [{ type: "text", text: errors ? `${r.text}\n${errors}` : r.text }];
        if (r.image) content.push({ type: "image", data: r.image.toString("base64"), mimeType: "image/png" });
        return { content, ...(r.ok ? {} : { isError: true }) };
      }),
  );

  tool(
    "three_lessons",
    {
      title: "Lessons from real three.js projects",
      description:
        "Lessons from real three.js and react-three-fiber projects: symptom, cause, fix and how to test it. Pass `error` with a console or build message to get the lessons that explain it; `rule` with a review rule id for why it matters; `query` with words ('textures washed out', 'shadow cut off', 'model invisible'); `topic` to list one topic; `id` for one lesson in full. With `id` and `verdict` (helped or wrong) it records whether the lesson fit, which ranks lessons on this machine. Lessons you kept with three_lesson_add are included.",
      inputSchema: {
        query: z.string().optional(),
        error: z.string().optional().describe("a message as it was printed"),
        rule: z.string().optional().describe("a review rule id"),
        id: z.string().optional(),
        topic: z.enum(LESSON_TOPICS).optional(),
        verdict: z.enum(["helped", "wrong"]).optional().describe("with id: did the lesson fit?"),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: WRITES,
    },
    async ({ query, error, rule, id, topic, verdict, limit }) =>
      guard(() => {
        const max = limit ?? (tier === "cheap" ? 5 : 12);
        if (id) {
          if (verdict) {
            const c = recordLessonFeedback(id, verdict);
            return text(`recorded: ${id} ${verdict} (helped ${c.helped}, wrong ${c.wrong} on this machine)`);
          }
          const hit = findLesson(id);
          return hit ? text(formatLesson(hit)) : failure(`no lesson ${id}; three_lessons with query lists them.`);
        }
        let hits: LessonHit[];
        if (error) hits = lessonsForError(error, { limit: max });
        else if (rule) hits = lessonsForRule(rule, { limit: max });
        else if (query || topic) hits = searchLessons(query ?? "", { ...(topic ? { topic } : {}), limit: max });
        else return failure("Pass query, error, rule, topic or id.");
        // the best match in full, the rest as a list: one call is usually enough
        if (hits.length && (error || tier === "premium")) {
          const [first, ...rest] = hits;
          return text([formatLesson(first!), ...(rest.length ? ["", formatLessonList(rest)] : [])].join("\n"));
        }
        return text(formatLessonList(hits, error ?? rule ?? query ?? topic ?? ""), hits.length === 0);
      }),
  );

  tool(
    "three_lesson_add",
    {
      title: "Keep a lesson learned here",
      description:
        "Keep a lesson you learned while fixing a three.js problem, so it comes back the next time the same message or question shows up (in three_lessons, three_explain, three_check and the review). Write it in general words: title (the lesson in one line) and fix are required; symptom, cause, test, topic, tags, rules, and `error` with the exact console or build message. Names, paths, e-mail addresses, links and code are taken out before it is stored, and the file never leaves this machine ($THREESMITH_HOME). The same title updates the lesson.",
      inputSchema: {
        title: z.string(),
        fix: z.string(),
        symptom: z.string().optional(),
        cause: z.string().optional(),
        test: z.string().optional(),
        topic: z.enum(LESSON_TOPICS).optional(),
        tags: z.array(z.string()).optional(),
        rules: z.array(z.string()).optional(),
        error: z.string().optional(),
        path: pathParam,
      },
      annotations: WRITES,
    },
    async (a) =>
      guard(() => {
        let knownNames: string[] | undefined;
        try {
          knownNames = [...indexFor(where(a.path)).exports.keys()];
        } catch {
          knownNames = undefined;
        }
        const { path: _p, ...input } = a;
        const r = addLocalLesson(input as LessonInput, { ...(knownNames ? { knownNames } : {}) });
        const scrubbed = Object.entries(r.replaced).map(([k, n]) => `${n} ${k}`).join(", ");
        return text(`${r.updated ? "updated" : "kept"} ${r.lesson.id}${scrubbed ? ` (scrubbed: ${scrubbed})` : ""}\n${formatLesson({ lesson: r.lesson, local: true, helped: 0, wrong: 0 })}`);
      }),
  );

  tool(
    "three_explain",
    {
      title: "Explain a three.js error",
      description:
        "Likely cause and fix of a three.js error or warning from the console, a build, a test run or a bug report: missing exports and wrong import paths (with the right path for the installed version), classes that no longer exist, two copies of three, objects used before a model loaded, 404 HTML instead of a model, Draco/KTX2 decoders, NaN geometry, lost contexts, shader compile errors, CORS, file://, WebGPU init. Paste the message as it was printed. Read-only.",
      inputSchema: { message: z.string(), path: pathParam, three: threeParam },
      annotations: READ,
    },
    async ({ message, path, three }) =>
      guard(() => {
        let index;
        try {
          index = indexFor(where(path), three);
        } catch {
          index = undefined;
        }
        const r = explain(message, index);
        const hints = lessonHintsForMessages([message]);
        const body = r.length || !hints.length ? formatExplanations(r) : "No known pattern for this message.";
        return text(hints.length ? `${body}\n${hints.join("\n")}` : body);
      }),
  );

  tool(
    "three_version",
    {
      title: "Installed three.js version",
      description: "Which three.js release the project has installed (such as r187), and where. Read-only.",
      inputSchema: { path: pathParam, three: threeParam },
      annotations: READ,
    },
    async ({ path, three }) =>
      guard(() => {
        const i = indexFor(where(path), three).install;
        return text(`three r${i.release} (${i.version}) at ${i.root}`);
      }),
  );

  return server;
}

export async function serveStdio(options: ServerOptions = {}): Promise<void> {
  await createServer(options).connect(new StdioServerTransport());
}
