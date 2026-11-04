/**
 * The server instructions per profile, filtered by the tools that are enabled, so an agent is never told to call a
 * tool that is not there. A line is split into parts by "|": a part that names a tool that is not enabled is left out,
 * and a line whose first part is left out is dropped. A part that starts with "{three_a three_b}" is also left out
 * unless one of those tools is enabled. Lines that start with "#." are numbered steps.
 */
const CHEAP: string[] = [
  "Threesmith checks three.js code against the three version installed in this project, and runs the page headless.| Follow these steps:",
  "#. In a project you do not know yet, or when a scene is broken and you do not know where to start, call three_doctor: what is wrong, in which order to fix it.",
  "#. Call three_scan once to learn the stack, pages, three files, renderer settings and assets.",
  "#. Before you use a three.js class, method, property or import path you are not sure about, call three_api. Never guess: three removes APIs often and your memory holds old ones.",
  "#. Before you save new three.js code, pass it to three_review (code + file) and fix every error.",
  "#. After every edit, call three_review with only_new: true. Fix all errors before the next step.",
  "#. Before you finish, call three_check on the page (a folder with index.html or the dev server URL) and look at the screenshot.",
  "When the picture is black, empty or wrong, call three_inspect before you guess: it reads the live scene and says why objects are not visible.",
  "When the console, the build or a test prints an error you do not understand, pass it to three_explain|; three_lessons with the message as error gives lessons from real projects|.",
  "For findings three_fix can do (renamed classes, import paths, color space renames, pixel ratio), call three_fix (dry run, then write: true) instead of editing them by hand.",
  "If a three_fix write made things worse, call three_undo.",
  "If you verified that a review finding is a false alarm, pass it to three_feedback with verdict wrong.",
  "Before you load a model or texture, call three_assets (or read the assets part of three_scan): a wrong path is a 404 that GLTFLoader reports as a parse error.",
  "When you fixed something that took more than one try, keep the lesson with three_lesson_add (general words, no names or code).",
  "To prove an interaction works, call three_play with steps, watch and expect|; when it passes, keep it with three_scenario op save|.",
  "Measure with three_perf before and after a performance change (draw calls and triangles are exact; frame times are relative).",
  "When memory grows while the user switches levels or opens and closes things, call three_leaks with the steps of one cycle.",
  "Before you call a build done, call three_build: it builds, checks the output (two copies of three, missing assets, base path) and opens it headless.",
  "{three_model_brief three_model_identify three_model_build three_model_view three_model_lint three_model_inspect}To make or check a 3D model (.glb):| three_model_brief first (one page with everything).| three_model_identify says what the thing is: parts, size, pivots.| three_model_spec shows the spec format.| three_model_build builds it.| three_model_view shows it as text (you cannot see pictures).| three_model_lint checks it.| three_model_inspect says what is in any .glb, and which loaders and decoders three.js needs for it.",
  "Keep each change small. Pin import paths to the installed release: 'three/addons/...' for addons.",
];

const PREMIUM: string[] = [
  "Threesmith gives you exact three.js knowledge for the release installed in this project, and runs the page in headless Chromium (software WebGL 2).",
  "- three_doctor answers \"what is wrong here, and in which order do I fix it\": versions, the scene showing nothing, assets that will not load, removed APIs, colour, performance and cleanup, grouped by cause, most urgent first,| with what three_fix can do,| then numbered next steps. Start here in a project you do not know or when something is broken.",
  "- three_scan maps the project: bundler and framework, versions of three, @types/three and the libraries around it, pages and import maps, every file that uses three with what it makes (renderer, cameras, lights, controls, loaders, the loop), renderer settings and assets.",
  "- three_api and three_search answer from node_modules/three (JSDoc and exports), offline: constructors, members, deprecations and the import path. Use them instead of memory.",
  "- three_review is a scored static review (0-100) pinned to the installed release: removed and renamed APIs, symbols that do not exist, code that renders nothing, per-frame allocations, resize and dispose, colour management. `code` + `file` reviews unsaved code; `only_new: true` shows only what changed since the last review; `files` focuses the list.",
  "- three_fix applies the renames that mean exactly the same (dry run first, then write: true, undoable with three_undo).",
  "- three_rules lists every review rule with its fix; three_feedback marks a finding as a false alarm (hidden on this machine from then on).",
  "- three_explain gives the likely cause and fix of a console, build or test message, with the right import path for the installed release.",
  "- three_lessons answers from lessons learned in real three.js projects (symptom, cause, fix, how to test): by words, by an error message, by a rule. three_lesson_add keeps one you learned here, scrubbed of names, paths and code.",
  "- three_assets resolves every asset path in the code like the dev server and a static host do: missing files, paths that only work on a case-insensitive disk, Draco/KTX2 decoder folders, glTF files that need a decoder the code never sets up, huge textures, unused files.",
  "- three_check opens the page headless: console and page errors with explanations, failed requests, no canvas or context, lost context, blank frames, a screenshot, and screenshot baselines with a diff. `steps` interact first.",
  "- three_inspect reads the live scene graph (three's devtools hook): camera, draw calls, triangles, GPU memory growth, and why objects are not visible.",
  "- three_play runs steps (click, press, hold, drag, wheel, frames, eval, until) and returns the values you watch after each step, with expect claims judged; three_scenario keeps a passing run as a regression test that ci runs.",
  "- three_perf measures frames, draw calls, triangles, programs and textures against a budget and against the last run; three_leaks repeats a cycle of steps and reports what grows per cycle.",
  "- three_build runs the project's build, checks the output (two copies of three, missing assets, absolute paths that break under a sub-path, case) and opens the built page headless.",
  "{three_model_brief three_model_identify three_model_spec three_model_build three_model_view three_model_lint three_model_inspect}- 3D models without Blender:| three_model_brief is one page before you build;| three_model_identify says what a thing is (parts, pivots, size);| three_model_spec explains the JSON spec;| three_model_build makes a clean .glb from a kind or a spec;| three_model_view draws a .glb as text views for agents that cannot see pictures;| three_model_lint scores a .glb (and checks it against what it should be);| three_model_inspect lists what is in a .glb and which three.js loaders and decoders it needs.",
  "- three_undo undoes the last Threesmith writes, newest first; a file changed by hand since is left alone.",
  "Work in reviewed steps: look up the API, write, review (only_new), fix, then check the page before you finish.| When a fix was hard, keep the lesson (three_lesson_add).",
];

const TOOL = /\bthree_[a-z_]+/g;
const ANY = /^\{([^}]*)\}/;

function keep(part: string, enabled: ReadonlySet<string>): boolean {
  const tag = ANY.exec(part);
  if (tag && !tag[1]!.split(/\s+/).some((t) => enabled.has(t))) return false;
  return [...part.replace(ANY, "").matchAll(TOOL)].every((m) => enabled.has(m[0]));
}

export type Tier = "cheap" | "premium";

export function renderInstructions(tier: Tier, enabled: ReadonlySet<string>, readOnly = false): string {
  const out: string[] = [];
  let step = 0;
  for (const line of tier === "cheap" ? CHEAP : PREMIUM) {
    const parts = line.split("|");
    const kept = parts.map((p) => keep(p, enabled));
    if (!kept[0]) continue;
    let text = parts
      .filter((_, i) => kept[i])
      .map((p) => p.replace(ANY, ""))
      .join("");
    if (text.startsWith("#. ")) text = `${++step}. ${text.slice(3)}`;
    out.push(text);
    if (out.length === 1 && readOnly) out.push("This session is read-only: tools that change project files only show their dry run, and write options are refused.");
  }
  if (step === 0 && out[0]) out[0] = out[0].replace(" Follow these steps:", "");
  return out.join("\n");
}
