import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
        return result(formatTriage(t, { detail: detail ?? profile.detail }), doctorData(t, profile.findings), false);
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
        const note = formatLearned(learned);
        const shown = focus.length ? { ...r, findings: r.findings.filter((f) => focus.includes(f.file)) } : r;
        return result(note ? `${body}\n${note}` : body, reviewData(shown, cap, full || tier === "premium"), false);
      }),
  );

  tool(
    "three_fix",
    {
      title: "Apply mechanical three.js fixes",
      description:
        "Apply the review fixes that need no decision: renames with exactly the same meaning (BoxBufferGeometry -> BoxGeometry, THREE.Math -> MathUtils, applyMatrix -> applyMatrix4, three/examples/jsm -> three/addons, outputEncoding/encoding -> colorSpace, merged geometry utils) and a capped pixel ratio. Shows what it would change unless write is true; a write is one undoable step (three_undo). Run three_review afterwards; the rest needs a decision.",
      inputSchema: { path: pathParam, target: z.string().optional().describe("same as path (older name)"), write: z.boolean().optional(), only: z.array(z.string()).optional().describe("rule ids to fix"), three: threeParam },
      annotations: WRITES,
    },
    async ({ path, target: older, write, only, three }) =>
      guard(() => {
        const target = where(path ?? older);
        const r = fix({ path: target, ...(three ? { three } : {}), ...(only ? { only } : {}) });
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
        return result(formatCheck(r), checkData(r, profile.findings), !r.ok, extra);
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
        return text(formatExplanations(r));
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
