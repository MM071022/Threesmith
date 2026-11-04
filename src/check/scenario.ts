import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { claimText, parseClaim, play as realPlay, type Claim, type ClaimResult, type PlayOptions, type PlayResult } from "./play.js";
import { parsePlaySteps, type PlayStep } from "./steps.js";
import type { Writer } from "./util.js";

/**
 * Scenarios: a play run that passed, saved as .threesmith/scenarios/<name>.json, so `threesmith ci` can run it again
 * and say when the behaviour changed. JUnit XML for the CI test tab.
 */

export const SCENARIO_DIR = ".threesmith/scenarios";
export const SCENARIO_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class ScenarioError extends Error {}

export interface Scenario {
  name: string;
  /** Page folder relative to the project (default "."), or an http(s) URL. */
  target?: string;
  entry?: string;
  /** Served folder relative to the project. */
  root?: string;
  width?: number;
  height?: number;
  wait?: number;
  sampleMs?: number;
  steps: PlayStep[];
  watch: string[];
  /** Claims as text: "$('p').position.y > 1 @ end", "any: ...", "always: ...". */
  expect: string[];
  ignore?: string[];
}

export interface ScenarioResult {
  name: string;
  /** Path relative to the project. */
  file: string;
  ok: boolean;
  claims: ClaimResult[];
  /** Page errors, failed requests and failed steps. */
  errors: string[];
  seconds: number;
  screenshot?: string;
  run: PlayResult;
}

const isUrl = (t: string) => /^https?:\/\//.test(t);
const posix = (p: string) => p.split(sep).join("/");

export function parseScenario(json: unknown, fallbackName: string): Scenario {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new ScenarioError("a scenario is a JSON object");
  const o = json as Record<string, unknown>;
  const text = (k: string): string | undefined => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new ScenarioError(`"${k}" must be text`);
    return v;
  };
  const num = (k: string): number | undefined => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ScenarioError(`"${k}" must be a number of 0 or more`);
    return v;
  };
  const strings = (k: string): string[] => {
    const v = o[k];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ScenarioError(`"${k}" must be a list of strings`);
    return v as string[];
  };
  let steps: PlayStep[];
  try {
    steps = parsePlaySteps(o["steps"] ?? []);
  } catch (e) {
    throw new ScenarioError(`"steps": ${(e as Error).message}`);
  }
  const rawExpect = o["expect"] ?? [];
  if (!Array.isArray(rawExpect)) throw new ScenarioError('"expect" must be a list');
  const expect = rawExpect.map((c: unknown) => {
    try {
      return typeof c === "string" ? (parseClaim(c), c.trim()) : claimText(parseClaim(c as Claim));
    } catch (e) {
      throw new ScenarioError(`"expect": ${(e as Error).message}`);
    }
  });
  if (!expect.length) throw new ScenarioError('a scenario needs at least one claim in "expect"');
  const out: Scenario = { name: text("name") ?? fallbackName, steps, watch: strings("watch"), expect };
  for (const k of ["target", "entry", "root"] as const) {
    const v = text(k);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ["width", "height", "wait", "sampleMs"] as const) {
    const v = num(k);
    if (v !== undefined) out[k] = v;
  }
  const ignore = strings("ignore");
  if (ignore.length) out.ignore = ignore;
  return out;
}

/** The file content of a scenario: stable key order, defaults left out. */
export function scenarioJson(s: Scenario): Record<string, unknown> {
  return {
    name: s.name,
    ...(s.target && s.target !== "." ? { target: s.target } : {}),
    ...(s.entry && s.entry !== "index.html" ? { entry: s.entry } : {}),
    ...(s.root ? { root: s.root } : {}),
    ...(s.width ? { width: s.width } : {}),
    ...(s.height ? { height: s.height } : {}),
    ...(s.wait !== undefined ? { wait: s.wait } : {}),
    ...(s.sampleMs !== undefined ? { sampleMs: s.sampleMs } : {}),
    steps: s.steps,
    ...(s.watch.length ? { watch: s.watch } : {}),
    expect: s.expect,
    ...(s.ignore?.length ? { ignore: s.ignore } : {}),
  };
}

/** Play options as a scenario of the project: paths made relative to it, claims as text. */
export function scenarioFromPlay(projectDir: string, name: string, opts: PlayOptions): { path: string; file: string; json: string; scenario: Scenario } {
  if (!SCENARIO_NAME.test(name)) throw new ScenarioError("name must be 1 to 64 letters, digits, _ or -");
  const project = resolve(projectDir);
  const rel = (p: string) => {
    const r = posix(relative(project, resolve(p)));
    if (r.startsWith("..") || isAbsolute(r)) throw new ScenarioError(`${p} is outside the project ${project}; a scenario keeps paths relative to it`);
    return r || ".";
  };
  const data = {
    name,
    target: isUrl(opts.target) ? opts.target : rel(opts.target),
    ...(opts.entry ? { entry: opts.entry } : {}),
    ...(opts.root ? { root: rel(opts.root) } : {}),
    ...(opts.width ? { width: opts.width } : {}),
    ...(opts.height ? { height: opts.height } : {}),
    ...(opts.wait !== undefined ? { wait: opts.wait } : {}),
    ...(opts.sampleMs !== undefined ? { sampleMs: opts.sampleMs } : {}),
    steps: opts.steps ?? [],
    watch: opts.watch ?? [],
    expect: (opts.expect ?? []).map((c) => (typeof c === "string" ? c.trim() : claimText(c))),
    ...(opts.ignore?.length ? { ignore: opts.ignore } : {}),
  };
  const scenario = parseScenario(data, name);
  const json = `${JSON.stringify(scenarioJson(scenario), null, 2)}\n`;
  parseScenario(JSON.parse(json), name); // the loader must read back what is written
  const file = `${SCENARIO_DIR}/${name}.json`;
  return { path: join(project, ...file.split("/")), file, json, scenario };
}

/** Play options for a scenario of the project. */
export function scenarioPlayOptions(projectDir: string, s: Scenario): PlayOptions {
  const project = resolve(projectDir);
  const target = s.target && isUrl(s.target) ? s.target : resolve(project, s.target ?? ".");
  return {
    target,
    ...(s.entry ? { entry: s.entry } : {}),
    ...(s.root ? { root: resolve(project, s.root) } : {}),
    ...(s.width ? { width: s.width } : {}),
    ...(s.height ? { height: s.height } : {}),
    ...(s.wait !== undefined ? { wait: s.wait } : {}),
    ...(s.sampleMs !== undefined ? { sampleMs: s.sampleMs } : {}),
    ...(s.ignore ? { ignore: s.ignore } : {}),
    stateDir: join(project, ".threesmith"),
    steps: s.steps,
    watch: s.watch,
    expect: s.expect,
    name: s.name,
  };
}

const defaultWriter: Writer = (p, data) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};

export interface SaveOptions {
  /** Writes the file; pass the journal's writer so the save can be undone. Default: a plain write. */
  write?: Writer;
  /** A run of these options that already happened; without it the scenario is played first. */
  result?: PlayResult;
  /** Replaces the real run, for tests. */
  play?: typeof realPlay;
  overwrite?: boolean;
}

export interface SaveResult {
  saved: boolean;
  /** Absolute path of the scenario file. */
  path: string;
  file: string;
  result: PlayResult;
  /** Why it was not saved. */
  reason?: string;
}

/** Saves a passing play run as a scenario. A failing run is not saved: a scenario states what works. */
export async function saveScenario(projectDir: string, name: string, opts: PlayOptions, so: SaveOptions = {}): Promise<SaveResult> {
  const made = scenarioFromPlay(projectDir, name, opts);
  if (existsSync(made.path) && !so.overwrite) throw new ScenarioError(`${made.file} exists; pass overwrite to replace it`);
  const result = so.result ?? (await (so.play ?? realPlay)(scenarioPlayOptions(projectDir, made.scenario)));
  if (!result.ok) return { saved: false, path: made.path, file: made.file, result, reason: "the run did not pass; fix it or the claims first" };
  (so.write ?? defaultWriter)(made.path, made.json);
  return { saved: true, path: made.path, file: made.file, result };
}

/** The scenario files of a project, sorted by name. Throws ScenarioError naming the file that does not read. */
export function loadScenarios(projectDir: string): { file: string; scenario: Scenario }[] {
  const dir = join(resolve(projectDir), ...SCENARIO_DIR.split("/"));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const file = `${SCENARIO_DIR}/${f}`;
      try {
        return { file, scenario: parseScenario(JSON.parse(readFileSync(join(dir, f), "utf8")), f.replace(/\.json$/, "")) };
      } catch (e) {
        throw new ScenarioError(`${file}: ${(e as Error).message}`);
      }
    });
}

export async function runScenario(projectDir: string, s: Scenario, opts: { file?: string; play?: typeof realPlay } = {}): Promise<ScenarioResult> {
  const started = Date.now();
  const run = await (opts.play ?? realPlay)(scenarioPlayOptions(projectDir, s));
  const errors = run.issues.filter((i) => i.severity === "error").map((i) => `[${i.kind}] ${i.message}`);
  return {
    name: s.name,
    file: opts.file ?? `${SCENARIO_DIR}/${s.name}.json`,
    ok: run.ok,
    claims: run.claims,
    errors,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    ...(run.screenshot ? { screenshot: run.screenshot } : {}),
    run,
  };
}

/** Runs the project's scenarios (those named `name`, else those whose name contains it; all without a name). */
export async function runScenarios(projectDir: string, opts: { name?: string; play?: typeof realPlay } = {}): Promise<ScenarioResult[]> {
  let list = loadScenarios(projectDir);
  if (opts.name) {
    const exact = list.filter((x) => x.scenario.name === opts.name);
    list = exact.length ? exact : list.filter((x) => x.scenario.name.includes(opts.name!));
  }
  const out: ScenarioResult[] = [];
  for (const x of list) out.push(await runScenario(projectDir, x.scenario, { file: x.file, ...(opts.play ? { play: opts.play } : {}) }));
  return out;
}

export function formatScenario(r: ScenarioResult, opts: { brief?: boolean } = {}): string {
  if (r.ok && opts.brief) return `PASS  ${r.name}  (${r.claims.length} claims, ${r.seconds}s)`;
  const out = [`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.file}, ${r.seconds}s)`];
  for (const c of r.claims) out.push(`  ${c.ok ? "ok  " : "FAIL"} ${c.text}${c.ok ? "" : `  -> ${c.message}`}`);
  for (const e of r.errors) out.push(`  error: ${e}`);
  return out.join("\n");
}

export function formatScenarios(results: ScenarioResult[], opts: { brief?: boolean } = {}): string {
  if (!results.length) return `no scenarios in ${SCENARIO_DIR}`;
  const failed = results.filter((r) => !r.ok).length;
  return [...results.map((r) => formatScenario(r, opts)), `${results.length - failed} of ${results.length} scenarios passed`].join("\n");
}

/** Text safe in XML: the five entities escaped, characters XML 1.0 forbids dropped. */
export function escapeXml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * JUnit XML (GitLab, Jenkins, Azure DevOps and the GitHub test-report actions read it): one suite per scenario,
 * a test case per claim, and a case "run" with an error when the page raised errors or a step failed.
 */
export function formatJunit(results: ScenarioResult[], suitesName = "threesmith"): string {
  const attr = (k: string, v: string | number) => ` ${k}="${escapeXml(String(v))}"`;
  const line = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 500);
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let time = 0;
  const suites = results.map((r) => {
    const cls = `scenario.${r.name}`;
    const cases = r.claims.map((c) => {
      const open = `    <testcase${attr("classname", cls)}${attr("name", c.text)}${attr("file", r.file)}`;
      if (c.ok) return `${open}/>`;
      return `${open}>\n      <failure${attr("message", line(c.message))}>${escapeXml(`${c.text}\n${c.message}${c.value !== undefined ? `\nvalue: ${JSON.stringify(c.value)}` : ""}`)}</failure>\n    </testcase>`;
    });
    if (r.errors.length) {
      cases.push(`    <testcase${attr("classname", cls)}${attr("name", "run")}${attr("file", r.file)}>\n      <error${attr("message", line(r.errors[0]!))}>${escapeXml(r.errors.join("\n"))}</error>\n    </testcase>`);
    }
    const f = r.claims.filter((c) => !c.ok).length;
    const e = r.errors.length ? 1 : 0;
    tests += cases.length;
    failures += f;
    errors += e;
    time += r.seconds;
    return [`  <testsuite${attr("name", cls)}${attr("tests", cases.length)}${attr("failures", f)}${attr("errors", e)}${attr("skipped", 0)}${attr("time", r.seconds)}${attr("file", r.file)}>`, ...cases, "  </testsuite>"].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites${attr("name", suitesName)}${attr("tests", tests)}${attr("failures", failures)}${attr("errors", errors)}${attr("time", Math.round(time * 1000) / 1000)}>`,
    ...suites,
    "</testsuites>",
    "",
  ].join("\n");
}
