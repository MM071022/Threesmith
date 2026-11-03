import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import { formatSearch, lookup, search } from "./api/lookup.js";
import { check, formatCheck, parseSteps } from "./check/check.js";
import { ci } from "./ci.js";
import { indexFor } from "./core.js";
import { formatMarkdown, formatText } from "./review/format.js";
import { formatFix, fix } from "./review/fix.js";
import { review } from "./review/review.js";
import type { Severity } from "./review/types.js";
import { doctor, formatDoctor } from "./doctor/doctor.js";
import { explain, formatExplanations } from "./explain/explain.js";
import { formatScene } from "./check/inspect.js";
import { HOOK_EVENTS, runHook, type HookEvent, type HookInput } from "./hooks/hooks.js";
import { VERSION } from "./version.js";

function out(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

export function buildProgram(): Command {
  const program = new Command("threesmith")
    .description("Makes coding agents better at three.js: version-pinned API lookup, scored review, headless check.")
    .version(VERSION);

  program
    .command("api")
    .description("Look up a three.js class, constant or member in the installed version")
    .argument("<query>", "Mesh | WebGLRenderer.setSize | OrbitControls")
    .option("-p, --path <dir>", "project directory", ".")
    .option("--three <dir>", "path to a three package")
    .option("--inherited", "also list inherited members")
    .option("--full", "full class description")
    .option("--json", "JSON output")
    .action((query: string, o: { path: string; three?: string; inherited?: boolean; full?: boolean; json?: boolean }) => {
      const r = lookup(indexFor(o.path, o.three), query, { ...(o.inherited ? { inherited: true } : {}), ...(o.full ? { full: true } : {}) });
      out(o.json ? JSON.stringify(r) : r.text);
      if (!r.found) process.exitCode = 1;
    });

  program
    .command("search")
    .description("Search the installed three.js API by name")
    .argument("<query>")
    .option("-p, --path <dir>", "project directory", ".")
    .option("--three <dir>", "path to a three package")
    .option("--members", "also search method and property names")
    .option("--limit <n>", "max results", "15")
    .option("--json", "JSON output")
    .action((query: string, o: { path: string; three?: string; members?: boolean; limit: string; json?: boolean }) => {
      const index = indexFor(o.path, o.three);
      const hits = search(index, query, { ...(o.members ? { members: true } : {}), limit: Number(o.limit) });
      out(o.json ? JSON.stringify(hits) : formatSearch(index, hits));
      if (!hits.length) process.exitCode = 1;
    });

  program
    .command("review")
    .description("Scored review of the three.js code in a directory or file")
    .argument("[path]", "directory or file", ".")
    .option("--three <dir>", "path to a three package to pin against")
    .option("--json", "JSON output")
    .option("--markdown", "markdown output")
    .option("--limit <n>", "max findings shown", "50")
    .option("--min-score <n>", "exit 1 when the score is lower")
    .option("--fail-on <severity>", "exit 1 on findings of this severity or worse: error | warn | info | none", "none")
    .option("--disable <rules>", "comma separated rule ids to skip")
    .action(
      (path: string, o: { three?: string; json?: boolean; markdown?: boolean; limit: string; minScore?: string; failOn: string; disable?: string }) => {
        const r = review({ path, ...(o.three ? { three: o.three } : {}), ...(o.disable ? { disable: o.disable.split(",") } : {}) });
        out(o.json ? JSON.stringify(r, null, 2) : o.markdown ? formatMarkdown(r, { limit: Number(o.limit) }) : formatText(r, { limit: Number(o.limit) }));
        const rank: Record<string, number> = { error: 0, warn: 1, info: 2 };
        if (o.failOn !== "none" && r.findings.some((f) => (rank[f.severity] ?? 9) <= (rank[o.failOn] ?? -1))) process.exitCode = 1;
        if (o.minScore !== undefined && r.score !== null && r.score < Number(o.minScore)) process.exitCode = 1;
      },
    );

  program
    .command("fix")
    .description("Apply the mechanical fixes of the review (renames with the same meaning); dry run unless --write")
    .argument("[path]", "directory or file", ".")
    .option("--three <dir>", "path to a three package")
    .option("--write", "change the files")
    .option("--only <rules>", "comma separated rule ids")
    .option("--json", "JSON output")
    .action((path: string, o: { three?: string; write?: boolean; only?: string; json?: boolean }) => {
      const r = fix({ path, ...(o.three ? { three: o.three } : {}), ...(o.write ? { write: true } : {}), ...(o.only ? { only: o.only.split(",") } : {}) });
      out(o.json ? JSON.stringify({ ...r, files: r.files.map(({ fixed: _f, ...rest }) => rest) }, null, 2) : formatFix(r));
    });

  program
    .command("check")
    .description("Open a page in headless Chromium (software WebGL 2) and report problems; optional screenshot baseline")
    .argument("<target>", "folder with the page, or an http(s) URL")
    .option("--entry <file>", "HTML file inside the folder", "index.html")
    .option("--root <dir>", "folder to serve, when the page needs files above its own folder (../node_modules)")
    .option("--wait <ms>", "let the scene run this long", "2000")
    .option("--width <px>", "viewport width", "800")
    .option("--height <px>", "viewport height", "600")
    .option("--baseline <name>", "compare with (or create) .threesmith/baselines/<name>.png")
    .option("--update-baseline", "overwrite the baseline with this run")
    .option("--tolerance <ratio>", "share of changed pixels that fails the baseline", "0.005")
    .option("--webgpu", "also enable WebGPU flags (best effort)")
    .option("--inspect", "also read the live scene graph and say why objects are not visible (done anyway when the frame is blank)")
    .option("--steps <json|file>", 'steps before the screenshot, e.g. \'[{"type":"click","selector":"#start"},{"type":"drag","from":[100,100],"to":[300,120]}]\' (types: wait, click, press, drag, wheel, wait-for)')
    .option("--ignore <text...>", "console messages containing this text are ignored")
    .option("--json", "JSON output")
    .action(async (target: string, o: { entry: string; root?: string; wait: string; width: string; height: string; baseline?: string; updateBaseline?: boolean; tolerance: string; webgpu?: boolean; inspect?: boolean; steps?: string; ignore?: string[]; json?: boolean }) => {
      const r = await check({
        ...(o.inspect ? { inspect: true } : {}),
        ...(o.steps ? { steps: parseSteps(o.steps.trim().startsWith("[") ? o.steps : readFileSync(o.steps, "utf8")) } : {}),
        target,
        entry: o.entry,
        ...(o.root ? { root: o.root } : {}),
        wait: Number(o.wait),
        width: Number(o.width),
        height: Number(o.height),
        tolerance: Number(o.tolerance),
        ...(o.baseline ? { baseline: o.baseline } : {}),
        ...(o.updateBaseline ? { updateBaseline: true } : {}),
        ...(o.webgpu ? { webgpu: true } : {}),
        ...(o.ignore ? { ignore: o.ignore } : {}),
      });
      out(o.json ? JSON.stringify(r, null, 2) : formatCheck(r));
      if (!r.ok) process.exitCode = 1;
    });

  program
    .command("inspect")
    .description("Open the page headless and show the live scene graph, camera, renderer stats, GPU memory growth and why objects are not visible")
    .argument("<target>", "folder with the page, or an http(s) URL")
    .option("--entry <file>", "HTML file inside the folder", "index.html")
    .option("--root <dir>", "folder to serve, when the page needs files above its own folder")
    .option("--wait <ms>", "let the scene run this long", "2000")
    .option("--leak <ms>", "sample GPU memory this many ms apart (0 = off)", "1500")
    .option("--steps <json|file>", "steps before inspecting (see check --steps)")
    .option("--nodes <n>", "max scene nodes to print", "80")
    .option("--json", "JSON output")
    .action(async (target: string, o: { entry: string; root?: string; wait: string; leak: string; steps?: string; nodes: string; json?: boolean }) => {
      const r = await check({
        target,
        entry: o.entry,
        ...(o.root ? { root: o.root } : {}),
        wait: Number(o.wait),
        inspect: true,
        leakMs: Number(o.leak),
        ...(o.steps ? { steps: parseSteps(o.steps.trim().startsWith("[") ? o.steps : readFileSync(o.steps, "utf8")) } : {}),
      });
      if (o.json) out(JSON.stringify(r, null, 2));
      else {
        const problems = r.issues.filter((i) => i.kind !== "scene");
        out([formatScene(r.scene ?? { found: false, renderer: null, camera: null, counts: { objects: 0, meshes: 0, lights: 0, nodesShown: 0 }, nodes: [], diagnoses: [] }, { maxNodes: Number(o.nodes) }), ...(problems.length ? ["", formatCheck({ ...r, issues: problems, scene: undefined } as typeof r)] : [])].join("\n"));
      }
      if (!r.ok) process.exitCode = 1;
    });

  program
    .command("explain")
    .description("Explain a three.js error or warning (console, build or test output): likely cause and fix. Reads stdin when no text is given")
    .argument("[message...]", "the error text")
    .option("-p, --path <dir>", "project directory, for exact names and import paths", ".")
    .option("--json", "JSON output")
    .action((words: string[], o: { path: string; json?: boolean }) => {
      const text = words.length ? words.join(" ") : readFileSync(0, "utf8");
      let index;
      try {
        index = indexFor(o.path);
      } catch {
        index = undefined;
      }
      const r = explain(text, index);
      out(o.json ? JSON.stringify(r, null, 2) : formatExplanations(r));
      if (!r.length) process.exitCode = 1;
    });

  program
    .command("ci")
    .description("Review (and optionally the headless check) in one receipt, for CI and pull requests")
    .argument("[path]", "project directory", ".")
    .option("--three <dir>", "path to a three package")
    .option("--min-score <n>", "fail below this score")
    .option("--fail-on <severity>", "error | warn | info | none", "error")
    .option("--check <target>", "also run the headless check on this folder or URL")
    .option("--entry <file>", "HTML file for --check", "index.html")
    .option("--root <dir>", "folder to serve for --check")
    .option("--baseline <name>", "baseline name for --check")
    .option("--update-baseline", "overwrite the baseline")
    .option("--wait <ms>", "ms to run the scene for --check", "2000")
    .option("--disable <rules>", "comma separated rule ids to skip")
    .option("--summary <file>", "append the markdown receipt to this file (use $GITHUB_STEP_SUMMARY)")
    .option("--out <file>", "write the markdown receipt to this file")
    .option("--json", "JSON output")
    .action(async (path: string, o: { three?: string; minScore?: string; failOn: string; check?: string; entry: string; root?: string; baseline?: string; updateBaseline?: boolean; wait: string; disable?: string; summary?: string; out?: string; json?: boolean }) => {
      const r = await ci({
        path,
        failOn: o.failOn as Severity | "none",
        ...(o.three ? { three: o.three } : {}),
        ...(o.minScore !== undefined ? { minScore: Number(o.minScore) } : {}),
        ...(o.disable ? { disable: o.disable.split(",") } : {}),
        ...(o.check
          ? { check: { target: o.check, entry: o.entry, ...(o.root ? { root: o.root } : {}), wait: Number(o.wait), ...(o.baseline ? { baseline: o.baseline } : {}), ...(o.updateBaseline ? { updateBaseline: true } : {}) } }
          : {}),
      });
      if (o.summary) appendFileSync(o.summary, r.markdown + "\n");
      if (o.out) {
        mkdirSync(dirname(o.out), { recursive: true });
        writeFileSync(o.out, r.markdown + "\n");
      }
      out(o.json ? JSON.stringify({ ok: r.ok, reasons: r.reasons, score: r.review.score, counts: r.review.counts }, null, 2) : r.markdown);
      if (!r.ok) process.exitCode = 1;
    });

  program
    .command("doctor")
    .description("Check what Threesmith needs here: Node, installed three, Playwright, Chromium with WebGL")
    .option("-p, --path <dir>", "project directory", ".")
    .option("--three <dir>", "path to a three package")
    .option("--json", "JSON output")
    .action(async (o: { path: string; three?: string; json?: boolean }) => {
      const items = await doctor(o.path, o.three);
      out(o.json ? JSON.stringify(items, null, 2) : formatDoctor(items));
      if (items.some((i) => !i.ok)) process.exitCode = 1;
    });

  program
    .command("hook")
    .description("Claude Code hook: reads the hook input on stdin, prints the hook output as JSON (used by the plugin)")
    .argument("<event>", HOOK_EVENTS.join(" | "))
    .action((event: string) => {
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
        process.exitCode = 2;
        return;
      }
      try {
        const input = JSON.parse(readFileSync(0, "utf8") || "{}") as HookInput;
        const result = runHook(event as HookEvent, input);
        if (result) out(JSON.stringify(result));
      } catch {
        /* fail open: a hook never gets in the way */
      }
    });

  program
    .command("mcp")
    .description("Run the MCP server on stdio (for Claude Code, Codex, Cursor, ...)")
    .option("--project <dir>", "default project directory for the tools (default: THREESMITH_PROJECT or the working directory)")
    .action(async (o: { project?: string }) => {
      const project = o.project ?? process.env["THREESMITH_PROJECT"];
      if (project && !project.startsWith("${")) process.chdir(project);
      const { serveStdio } = await import("./mcp/server.js");
      await serveStdio();
    });

  return program;
}
