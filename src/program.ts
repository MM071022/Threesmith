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
import { formatTriage, triage } from "./doctor/triage.js";
import { formatProjectMap, projectRootOf, scanProject } from "./scan/scan.js";
import { checkAssets, formatAssets } from "./scan/assets.js";
import { collect } from "./review/source.js";
import { RULES } from "./review/rules.js";
import { formatJournal, formatUndo, readJournal, undoJournal, writeFiles } from "./project/journal.js";
import { applyFeedback, formatLearned } from "./learn/feedback.js";
import { envFlag } from "./mcp/toolsets.js";
import { checkTypes, formatTypes } from "./types/types.js";
import { toSarif } from "./review/sarif.js";
import { LESSON_TOPICS } from "./lessons/types.js";
import { findLesson, lessonsForError, lessonsForRule, searchLessons } from "./lessons/search.js";
import { formatLesson, formatLessonList } from "./lessons/format.js";
import { recordLessonFeedback } from "./lessons/local.js";
import type { PageOptions } from "./check/page.js";
import { parsePlaySteps, type PlayStep } from "./check/steps.js";
import { formatPlay, play, type PlayOptions } from "./check/play.js";
import { formatJunit, formatScenarios, loadScenarios, runScenarios, saveScenario } from "./check/scenario.js";
import { formatPerf, perf } from "./check/perf.js";
import { formatLeaks, leaks } from "./check/leaks.js";
import { buildCheck, formatBuild } from "./check/build.js";
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
  formatRecipes,
  formatSetupProblems,
  identify,
  inspectModel,
  lintModelFile,
  modelNeeds,
  recipeSpec,
  viewModel,
} from "./model/index.js";
import { formatCompact } from "./review/compact.js";
import { join, relative } from "node:path";
import { statSync } from "node:fs";

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
    .option("--sarif <file>", "also write the findings as SARIF 2.1.0 (GitHub code scanning)")
    .option("--compact", "one line per finding (file:line severity [rule] message Fix: ...), the format agents read best")
    .option("--limit <n>", "max findings shown", "50")
    .option("--min-score <n>", "exit 1 when the score is lower")
    .option("--fail-on <severity>", "exit 1 on findings of this severity or worse: error | warn | info | none", "none")
    .option("--disable <rules>", "comma separated rule ids to skip")
    .action(
      (path: string, o: { three?: string; json?: boolean; markdown?: boolean; sarif?: string; compact?: boolean; limit: string; minScore?: string; failOn: string; disable?: string }) => {
        const { review: r, learned } = applyFeedback(review({ path, ...(o.three ? { three: o.three } : {}), ...(o.disable ? { disable: o.disable.split(",") } : {}) }));
        const note = formatLearned(learned);
        if (note && !o.json) process.stderr.write(note + "\n");
        if (o.sarif) {
          mkdirSync(dirname(o.sarif), { recursive: true });
          writeFileSync(o.sarif, JSON.stringify(toSarif(r), null, 1) + "\n");
        }
        out(o.json ? JSON.stringify(r, null, 2) : o.markdown ? formatMarkdown(r, { limit: Number(o.limit) }) : o.compact ? formatCompact(r, { limit: Number(o.limit) }) : formatText(r, { limit: Number(o.limit) }));
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
      const r = fix({ path, ...(o.three ? { three: o.three } : {}), ...(o.only ? { only: o.only.split(",") } : {}) });
      let id = 0;
      if (o.write && r.total) {
        const folder = statSync(path).isDirectory() ? path : join(path, "..");
        const root = projectRootOf(folder);
        id = writeFiles(root, "fix", `${r.total} mechanical fix(es)`, r.files.map((f) => ({ file: relative(root, join(folder, f.file)), data: f.fixed })));
        r.written = true;
      }
      out(o.json ? JSON.stringify({ ...r, files: r.files.map(({ fixed: _f, ...rest }) => rest) }, null, 2) : formatFix(r) + (id ? `\nUndo with \`threesmith undo\` (journal #${id}).` : ""));
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

  const stepsFrom = (list: string[] | undefined): PlayStep[] | undefined => {
    if (!list?.length) return undefined;
    const items = list.flatMap((s) => {
      const text = s.trim().startsWith("[") || s.trim().startsWith("{") ? s : readFileSync(s, "utf8");
      const v = JSON.parse(text) as unknown;
      return Array.isArray(v) ? v : [v];
    });
    return parsePlaySteps(items);
  };
  const pageFrom = (target: string, o: { entry?: string; root?: string; width?: string; height?: string; webgpu?: boolean }): PageOptions => ({
    target,
    ...(o.entry ? { entry: o.entry } : {}),
    ...(o.root ? { root: o.root } : {}),
    ...(o.width ? { width: Number(o.width) } : {}),
    ...(o.height ? { height: Number(o.height) } : {}),
    ...(o.webgpu ? { webgpu: true } : {}),
  });
  const budgetFrom = (s: string | undefined): Record<string, number> | undefined =>
    s ? Object.fromEntries(s.split(",").map((kv) => kv.split("=")).map(([k, v]) => [String(k).trim(), Number(v)])) : undefined;
  const pageOptions = (c: Command): Command =>
    c
      .option("--entry <file>", "HTML file inside the folder", "index.html")
      .option("--root <dir>", "folder to serve, when the page needs files above its own folder")
      .option("--width <px>", "viewport width")
      .option("--height <px>", "viewport height")
      .option("--webgpu", "also enable WebGPU flags (best effort)");

  pageOptions(
    program
      .command("play")
      .description("Run steps in the page headless, watch values in the live scene and judge claims; --save keeps a passing run as a scenario")
      .argument("<target>", "folder with the page, or an http(s) URL"),
  )
    .option("--step <json...>", 'steps as JSON (one step, an array, or a file), e.g. \'{"type":"press","key":"Space"}\'')
    .option("--watch <js...>", "expressions to follow, e.g. \"$('player').position.y\"")
    .option("--expect <claim...>", "claims, e.g. \"$('player').position.y > 1 @ end\", \"any: ...\", \"always: ...\"")
    .option("--wait <ms>", "ms before the first step", "1000")
    .option("--save <name>", "keep the run as .threesmith/scenarios/<name>.json when it passes")
    .option("--overwrite", "replace a scenario with the same name")
    .option("--json", "JSON output")
    .action(async (target: string, o: { step?: string[]; watch?: string[]; expect?: string[]; wait: string; save?: string; overwrite?: boolean; json?: boolean } & Record<string, string | boolean | undefined>) => {
      const steps = stepsFrom(o.step);
      const opts: PlayOptions = { ...pageFrom(target, o as never), wait: Number(o.wait), ...(steps ? { steps } : {}), ...(o.watch ? { watch: o.watch } : {}), ...(o.expect ? { expect: o.expect } : {}) };
      if (o.save) {
        const project = projectRootOf(/^https?:/.test(target) ? "." : target);
        const r = await saveScenario(project, o.save, opts, {
          write: (abs, data) => {
            writeFiles(project, "play --save", `save scenario ${o.save}`, [{ file: relative(project, abs), data }]);
          },
          ...(o.overwrite ? { overwrite: true } : {}),
        });
        out(o.json ? JSON.stringify(r, null, 2) : r.saved ? `saved ${r.file}` : `not saved: ${r.reason}\n${formatPlay(r.result)}`);
        if (!r.saved) process.exitCode = 1;
        return;
      }
      const r = await play(opts);
      out(o.json ? JSON.stringify(r, null, 2) : formatPlay(r));
      if (!r.ok) process.exitCode = 1;
    });

  program
    .command("scenario")
    .description("List or run the scenarios kept in .threesmith/scenarios (regression tests made from play runs)")
    .argument("<op>", "list | run")
    .argument("[name]", "for run: one scenario (exact or part of the name); default all")
    .option("-p, --path <dir>", "project directory", ".")
    .option("--junit <file>", "also write JUnit XML")
    .option("--json", "JSON output")
    .action(async (op: string, name: string | undefined, o: { path: string; junit?: string; json?: boolean }) => {
      const project = projectRootOf(o.path);
      if (op === "list") {
        const list = loadScenarios(project);
        out(o.json ? JSON.stringify(list, null, 2) : list.length ? list.map((s) => `${s.scenario.name} (${s.file})`).join("\n") : "No scenarios.");
        return;
      }
      if (op !== "run") throw new Error("op must be list or run");
      const rs = await runScenarios(project, { ...(name ? { name } : {}) });
      if (o.junit) {
        mkdirSync(dirname(o.junit), { recursive: true });
        writeFileSync(o.junit, formatJunit(rs));
      }
      out(o.json ? JSON.stringify(rs.map(({ run: _r, ...x }) => x), null, 2) : rs.length ? formatScenarios(rs) : "No scenarios to run.");
      if (rs.some((r) => !r.ok)) process.exitCode = 1;
    });

  pageOptions(
    program
      .command("perf")
      .description("Measure draw calls, triangles, programs, textures and frame times against a budget and the last run")
      .argument("<target>", "folder with the page, or an http(s) URL"),
  )
    .option("--step <json...>", "steps before measuring (see play)")
    .option("--seconds <n>", "how long to measure", "5")
    .option("--budget <list>", "limits, e.g. frameMs=20,calls=200,triangles=500000,textures=64")
    .option("--name <name>", "name for the comparison with the last run")
    .option("--no-save", "do not keep this run")
    .option("--json", "JSON output")
    .action(async (target: string, o: { step?: string[]; seconds: string; budget?: string; name?: string; save: boolean; json?: boolean } & Record<string, string | boolean | undefined>) => {
      const steps = stepsFrom(o.step);
      const budget = budgetFrom(o.budget);
      const r = await perf({ ...pageFrom(target, o as never), seconds: Number(o.seconds), ...(steps ? { steps } : {}), ...(budget ? { budget } : {}), ...(o.name ? { name: o.name } : {}), save: o.save });
      out(o.json ? JSON.stringify(r, null, 2) : formatPerf(r));
      if (!r.ok) process.exitCode = 1;
    });

  pageOptions(
    program
      .command("leaks")
      .description("Repeat a cycle of steps and report what grows per cycle (GPU resources never disposed, by type)")
      .argument("<target>", "folder with the page, or an http(s) URL"),
  )
    .requiredOption("--cycle <json...>", "the steps of one cycle (see play)")
    .option("--setup <json...>", "steps before the first cycle")
    .option("--cycles <n>", "how many cycles", "5")
    .option("--budget <list>", "growth allowed per cycle, e.g. geometries=0,textures=0,heapKb=200")
    .option("--json", "JSON output")
    .action(async (target: string, o: { cycle: string[]; setup?: string[]; cycles: string; budget?: string; json?: boolean } & Record<string, string | boolean | undefined>) => {
      const setup = stepsFrom(o.setup);
      const budget = budgetFrom(o.budget);
      const r = await leaks({ ...pageFrom(target, o as never), cycle: stepsFrom(o.cycle) ?? [], ...(setup ? { setup } : {}), cycles: Number(o.cycles), ...(budget ? { budget } : {}) });
      out(o.json ? JSON.stringify(r, null, 2) : formatLeaks(r));
      if (!r.ok) process.exitCode = 1;
    });

  program
    .command("build")
    .description("Run the project's build, check the output (copies of three, missing assets, sub-path URLs, decoders) and open the built page headless")
    .argument("[path]", "project directory", ".")
    .option("--script <name>", "package.json script", "build")
    .option("--out <dir>", "output folder (default from the bundler config)")
    .option("--base <base>", 'deploy base, e.g. "/repo/"')
    .option("--no-build", "check the existing output without building")
    .option("--no-check", "skip the headless check of the built page")
    .option("--json", "JSON output")
    .action(async (path: string, o: { script: string; out?: string; base?: string; build: boolean; check: boolean; json?: boolean }) => {
      const r = await buildCheck({ project: projectRootOf(path), script: o.script, ...(o.out ? { outDir: o.out } : {}), ...(o.base ? { base: o.base } : {}), ...(o.build ? {} : { run: false as const }), ...(o.check ? {} : { check: false as const }) });
      out(o.json ? JSON.stringify({ ...r, check: r.check ? { ok: r.check.ok, issues: r.check.issues } : undefined }, null, 2) : formatBuild(r));
      if (!r.ok) process.exitCode = 1;
    });

  const model = program.command("model").description("3D models for three.js without Blender: inspect, view, lint, identify, brief, spec, kinds, recipes, build");
  model
    .command("inspect")
    .description("What is in a .glb/.gltf and which three.js loaders and decoders it needs")
    .argument("<file>")
    .option("--full", "every node, material and texture")
    .option("--json", "JSON output")
    .action((file: string, o: { full?: boolean; json?: boolean }) => {
      const info = inspectModel(file);
      out(o.json ? JSON.stringify({ ...info, needs: modelNeeds(info) }, null, 2) : `${formatModelInfo(info, o.full ? "full" : "brief")}\n${formatModelNeeds(modelNeeds(info))}`);
    });
  model
    .command("needs")
    .description("The decoders a model needs, and whether the project's code sets them up")
    .argument("<file>")
    .option("-p, --path <dir>", "project directory", ".")
    .action((file: string, o: { path: string }) => {
      const needs = modelNeeds(inspectModel(file));
      const root = projectRootOf(o.path);
      const problems = checkModelSetup(needs, collect(root).files.map((f) => f.text));
      out(`${formatModelNeeds(needs)}\n${formatSetupProblems(problems)}`);
      if (problems.length) process.exitCode = 1;
    });
  model
    .command("view")
    .description("A model as text: front, side and top views, parts with sizes, parts that do not touch")
    .argument("<file>")
    .option("--only <view>", "front | side | top")
    .option("--width <n>", "characters per view")
    .action((file: string, o: { only?: "front" | "side" | "top"; width?: string }) => out(viewModel(file, { ...(o.only ? { only: o.only } : {}), ...(o.width ? { width: Number(o.width) } : {}) })));
  model
    .command("lint")
    .description("Score a model for the web; --archetype also checks it is what it should be")
    .argument("<file>")
    .option("--archetype <name>", "an archetype id or a name (car, tree, helikopter)")
    .option("--max-triangles <n>")
    .option("--max-draw-calls <n>")
    .option("--full", "every finding")
    .option("--json", "JSON output")
    .action((file: string, o: { archetype?: string; maxTriangles?: string; maxDrawCalls?: string; full?: boolean; json?: boolean }) => {
      const r = lintModelFile(file, { ...(o.archetype ? { archetype: o.archetype } : {}), ...(o.maxTriangles ? { maxTriangles: Number(o.maxTriangles) } : {}), ...(o.maxDrawCalls ? { maxDrawCalls: Number(o.maxDrawCalls) } : {}) });
      out(o.json ? JSON.stringify(r, null, 2) : formatLint(r, o.full ? "full" : "brief"));
      if (r.failed) process.exitCode = 1;
    });
  model
    .command("identify")
    .description("What a thing is: parts, pivots, size, variants (English or Dutch)")
    .argument("<what...>")
    .action((what: string[]) => out(formatIdentify(identify(what.join(" ")), archetypeLibrary())));
  model
    .command("brief")
    .description("One page before you build a thing")
    .argument("<what...>")
    .action((what: string[]) => out(briefFor(what.join(" ")).text));
  model
    .command("spec")
    .description("The model spec format and an example")
    .option("--short", "cheat sheet only")
    .action((o: { short?: boolean }) => out(o.short ? SPEC_CHEAT : `${SPEC_HELP}\n\nExample:\n${JSON.stringify(EXAMPLE_SPEC, null, 1)}`));
  model
    .command("kinds")
    .description("Every ready-made kind with its parameters")
    .action(() => out(formatKinds()));
  model
    .command("recipes")
    .description("The ready-made recipes, or the full spec of one to edit")
    .argument("[kind]")
    .action((kind?: string) => out(kind ? JSON.stringify(recipeSpec(kind), null, 1) : formatRecipes()));
  model
    .command("build")
    .description("Build a .glb from a kind or a spec file (undoable with threesmith undo)")
    .argument("[kind]", "a ready-made kind")
    .requiredOption("-o, --out <file>", "the .glb to write")
    .option("--spec <file>", "a JSON model spec instead of a kind")
    .option("--param <k=v...>", "parameters, e.g. --param length=4.5 color=#c22")
    .option("--seed <n>")
    .option("--no-textures", "plain colours instead of texture maps")
    .action((kind: string | undefined, o: { out: string; spec?: string; param?: string[]; seed?: string; textures: boolean }) => {
      const params = Object.fromEntries(
        (o.param ?? []).map((kv) => {
          const [k, ...rest] = kv.split("=");
          const v = rest.join("=");
          return [k, v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v === "true" ? true : v === "false" ? false : v];
        }),
      );
      const r = buildModel({ ...(kind ? { kind } : {}), ...(o.spec ? { spec: JSON.parse(readFileSync(o.spec, "utf8")) } : {}), ...(Object.keys(params).length ? { params } : {}), ...(o.seed ? { seed: Number(o.seed) } : {}), ...(o.textures ? {} : { textures: false }) });
      const root = projectRootOf(dirname(o.out));
      writeFiles(root, "model build", `build ${r.name}`, [{ file: relative(root, o.out), data: r.glb }]);
      out(`wrote ${o.out}: ${r.summary}\n${formatModelReport(r.report, "brief")}`);
      if (r.report.categories.some((c) => c.errors > 0)) process.exitCode = 1;
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
    .option("--no-scenarios", "do not run the scenarios in .threesmith/scenarios")
    .option("--junit <file>", "write the scenario results as JUnit XML")
    .option("--sarif <file>", "write the review findings as SARIF 2.1.0")
    .option("--summary <file>", "append the markdown receipt to this file (use $GITHUB_STEP_SUMMARY)")
    .option("--out <file>", "write the markdown receipt to this file")
    .option("--json", "JSON output")
    .action(async (path: string, o: { three?: string; minScore?: string; failOn: string; check?: string; entry: string; root?: string; baseline?: string; updateBaseline?: boolean; wait: string; disable?: string; scenarios: boolean; junit?: string; sarif?: string; summary?: string; out?: string; json?: boolean }) => {
      const r = await ci({
        path,
        scenarios: o.scenarios,
        failOn: o.failOn as Severity | "none",
        ...(o.three ? { three: o.three } : {}),
        ...(o.minScore !== undefined ? { minScore: Number(o.minScore) } : {}),
        ...(o.disable ? { disable: o.disable.split(",") } : {}),
        ...(o.check
          ? { check: { target: o.check, entry: o.entry, ...(o.root ? { root: o.root } : {}), wait: Number(o.wait), ...(o.baseline ? { baseline: o.baseline } : {}), ...(o.updateBaseline ? { updateBaseline: true } : {}) } }
          : {}),
      });
      if (o.junit) {
        mkdirSync(dirname(o.junit), { recursive: true });
        writeFileSync(o.junit, formatJunit(r.scenarios ?? []));
      }
      if (o.sarif) {
        mkdirSync(dirname(o.sarif), { recursive: true });
        writeFileSync(o.sarif, JSON.stringify(toSarif(r.review), null, 1) + "\n");
      }
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
    .description("What is wrong in this project and in which order to fix it (grouped by cause, with next steps), then what Threesmith needs here (Node, three, Playwright, Chromium with WebGL)")
    .option("-p, --path <dir>", "project directory", ".")
    .option("--three <dir>", "path to a three package")
    .option("--env", "only check the environment")
    .option("--no-env", "skip the environment check (no browser start)")
    .option("--full", "every cause and fix")
    .option("--json", "JSON output")
    .action(async (o: { path: string; three?: string; env?: boolean; full?: boolean; json?: boolean }) => {
      const envOnly = process.argv.includes("--env");
      const parts: string[] = [];
      let bad = false;
      let data: Record<string, unknown> = {};
      if (!envOnly) {
        const t = triage(o.path, { ...(o.three ? { three: o.three } : {}) });
        parts.push(formatTriage(t, { detail: o.full ? "full" : "brief" }));
        data = { ok: t.ok, score: t.score, counts: t.counts, groups: t.groups, next: t.next };
        if (!t.ok) bad = true;
      }
      if (o.env !== false) {
        const items = await doctor(o.path, o.three);
        parts.push(envOnly ? formatDoctor(items) : "\nEnvironment:\n" + formatDoctor(items));
        data = { ...data, environment: items };
        if (items.some((i) => !i.ok)) bad = true;
      }
      out(o.json ? JSON.stringify(data, null, 2) : parts.join("\n"));
      if (bad) process.exitCode = 1;
    });

  program
    .command("types")
    .description("Run the project's tsc --noEmit and explain the three.js type errors with the installed release (did you mean, import paths)")
    .argument("[path]", "project directory", ".")
    .option("--all", "also list type errors not about three")
    .option("--json", "JSON output")
    .action((path: string, o: { all?: boolean; json?: boolean }) => {
      const root = projectRootOf(path);
      let index;
      try {
        index = indexFor(root);
      } catch {
        index = undefined;
      }
      const r = checkTypes(root, { ...(index ? { index } : {}) });
      out(o.json ? JSON.stringify(r, null, 2) : formatTypes(r, { ...(o.all ? { all: true } : {}) }));
      if (!r.ran || r.errors.some((e) => e.three)) process.exitCode = 1;
    });

  program
    .command("lessons")
    .description("Lessons from real three.js projects: by words, an error message, a rule or a topic; --id for one in full")
    .argument("[query...]", "words")
    .option("--error <message>", "a console or build message")
    .option("--rule <id>", "a review rule id")
    .option("--topic <topic>", LESSON_TOPICS.join(" | "))
    .option("--id <id>", "one lesson in full")
    .option("--verdict <helped|wrong>", "with --id: record whether it fit")
    .option("--limit <n>", "max lessons", "10")
    .option("--json", "JSON output")
    .action((words: string[], o: { error?: string; rule?: string; topic?: string; id?: string; verdict?: string; limit: string; json?: boolean }) => {
      if (o.id) {
        if (o.verdict === "helped" || o.verdict === "wrong") {
          const c = recordLessonFeedback(o.id, o.verdict);
          out(`recorded: ${o.id} ${o.verdict} (helped ${c.helped}, wrong ${c.wrong})`);
          return;
        }
        const hit = findLesson(o.id);
        if (!hit) process.exitCode = 1;
        out(hit ? (o.json ? JSON.stringify(hit, null, 2) : formatLesson(hit)) : `no lesson ${o.id}`);
        return;
      }
      const limit = Number(o.limit);
      const topic = o.topic && (LESSON_TOPICS as readonly string[]).includes(o.topic) ? (o.topic as (typeof LESSON_TOPICS)[number]) : undefined;
      const hits = o.error ? lessonsForError(o.error, { limit }) : o.rule ? lessonsForRule(o.rule, { limit }) : searchLessons(words.join(" "), { ...(topic ? { topic } : {}), limit });
      out(o.json ? JSON.stringify(hits, null, 2) : formatLessonList(hits, o.error ?? o.rule ?? words.join(" ")));
      if (!hits.length) process.exitCode = 1;
    });

  program
    .command("scan")
    .description("Map the project: stack and versions, pages, files using three with what they create, renderer settings, assets")
    .argument("[path]", "project directory", ".")
    .option("--full", "imports per file, every asset problem, glTF extensions")
    .option("--json", "JSON output")
    .action((path: string, o: { full?: boolean; json?: boolean }) => {
      const m = scanProject(path);
      out(o.json ? JSON.stringify(m, null, 2) : formatProjectMap(m, o.full ? "full" : "brief"));
    });

  program
    .command("assets")
    .description("Check every asset path in the code: missing files, wrong capitals, decoder folders, glTF decoders the code never sets up, huge textures, unused files")
    .argument("[path]", "project directory", ".")
    .option("--limit <n>", "max problems shown", "50")
    .option("--json", "JSON output")
    .action((path: string, o: { limit: string; json?: boolean }) => {
      const root = projectRootOf(path);
      const r = checkAssets(root, collect(root).files);
      out(o.json ? JSON.stringify(r, null, 2) : formatAssets(r, { limit: Number(o.limit) }));
      if (r.problems.some((p) => p.severity === "error")) process.exitCode = 1;
    });

  program
    .command("rules")
    .description("List every review rule with its category, severity, release gating and fix")
    .argument("[query]", "words in the id or title")
    .option("--category <name>", "only this category")
    .option("--json", "JSON output")
    .action((query: string | undefined, o: { category?: string; json?: boolean }) => {
      const q = query?.toLowerCase();
      const list = RULES.filter((r) => (!o.category || r.category === o.category) && (!q || `${r.id} ${r.title}`.toLowerCase().includes(q)));
      if (o.json) out(JSON.stringify(list.map(({ check: _c, ...r }) => r), null, 2));
      else out(list.map((r) => `${r.id} (${r.category}, ${r.severity}${r.removedIn ? `, removed r${r.removedIn}` : ""}): ${r.title}\n  fix: ${r.fix}`).join("\n"));
      if (!list.length) process.exitCode = 1;
    });

  program
    .command("undo")
    .description("Undo the last Threesmith writes (fix --write and others), newest first; files changed by hand since are left alone")
    .option("-p, --path <dir>", "project directory", ".")
    .option("--steps <n>", "how many writes to undo", "1")
    .option("--force", "also restore files changed since the write")
    .option("--list", "only show the journal")
    .action((o: { path: string; steps: string; force?: boolean; list?: boolean }) => {
      const root = projectRootOf(o.path);
      out(o.list ? formatJournal(readJournal(root)) : formatUndo(undoJournal(root, { steps: Number(o.steps), ...(o.force ? { force: true } : {}) })));
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
    .option("--tier <tier>", "cheap: short output and step-by-step guidance (default); premium: full detail (THREESMITH_TIER)")
    .option("--tools <list>", "tool sets or tool names to offer: core, run, build, model, all, or three_check ... (THREESMITH_TOOLS)")
    .option("--read-only", "leave out tools that always write and refuse write options (THREESMITH_READ_ONLY=1)")
    .action(async (o: { project?: string; tier?: string; tools?: string; readOnly?: boolean }) => {
      const project = o.project ?? process.env["THREESMITH_PROJECT"];
      if (project && !project.startsWith("${")) process.chdir(project);
      const tier = o.tier ?? process.env["THREESMITH_TIER"] ?? "cheap";
      if (tier !== "cheap" && tier !== "premium") throw new Error(`--tier must be cheap or premium, got "${tier}"`);
      const tools = o.tools ?? process.env["THREESMITH_TOOLS"];
      const { serveStdio } = await import("./mcp/server.js");
      await serveStdio({ tier, ...(tools && !tools.startsWith("${") ? { tools } : {}), readOnly: o.readOnly === true || envFlag(process.env["THREESMITH_READ_ONLY"]) });
    });

  return program;
}
