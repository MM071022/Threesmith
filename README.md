<p align="center">
  <img src="docs/logo.svg" alt="Threesmith logo" width="72" height="72">
</p>
<h1 align="center">Threesmith</h1>
<p align="center"><b>Checks the three.js code your coding agent writes, runs the page headless, and gives the agent the tools to fix it.</b><br>
MCP server, CLI and Claude Code plugin. Works with Claude Code, Codex, Cursor, VS Code, Gemini CLI and any MCP client.</p>
<p align="center">
  <a href="https://github.com/laaielichter/Threesmith/actions/workflows/ci.yml"><img src="https://github.com/laaielichter/Threesmith/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/three.js-r187-049ef4?logo=threedotjs&logoColor=white" alt="Tested on three.js r187">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="https://vscode.dev/redirect/mcp/install?name=threesmith&config=%7B%22name%22%3A%22threesmith%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22threesmith%22%2C%22mcp%22%5D%7D"><img src="https://img.shields.io/badge/VS_Code-Install_MCP_server-0098FF?logo=visualstudiocode&logoColor=white" alt="Install in VS Code"></a>
  <a href="https://cursor.com/en/install-mcp?name=threesmith&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInRocmVlc21pdGgiLCJtY3AiXX0%3D"><img src="https://img.shields.io/badge/Cursor-Install_MCP_server-000000?logo=cursor&logoColor=white" alt="Install in Cursor"></a>
  <a href="#install-in-your-agent"><img src="https://img.shields.io/badge/Claude_Code-Add_plugin-D97757" alt="Add to Claude Code"></a>
</p>
<p align="center">
  <a href="https://laaielichter.github.io/Threesmith/">Website</a> ·
  <a href="https://laaielichter.github.io/Threesmith/install.html">Install in your agent</a> ·
  <a href="https://laaielichter.github.io/Threesmith/models.html">3D models</a> ·
  <a href="examples/agent-mistakes">Example</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>
<p align="center">
  <img src="docs/before-after.jpg" alt="Left: the black canvas of a scene a coding agent wrote. Right: the same scene after the fixes Threesmith listed, a lit crate and a character model" width="860"><br>
  <sub>Real run on <a href="examples/agent-mistakes">examples/agent-mistakes</a>: as the agent wrote it (3 review errors, 2 asset paths that 404, a black canvas), and after <code>threesmith fix</code> plus the fixes <code>threesmith doctor</code> listed (<a href="examples/agent-mistakes-fixed">100/100, check passes</a>).</sub>
</p>

three.js ships a release almost every month and removes old APIs. Coding agents learned it from years of code that used
`THREE.Geometry`, `outputEncoding`, `three/examples/js` and import paths that no longer exist, and they cannot see the
canvas they draw on. Threesmith is the check between the agent and your project: the API of **the three version you
have installed**, a scored review, the assets and decoders the code needs, the live scene in headless Chromium, and
safe, undoable edits. Everything runs locally; nothing leaves the machine.

## Without and with

| Your agent... | On its own | With Threesmith |
| --- | --- | --- |
| writes three.js | `Geometry`, `outputEncoding`, `BoxBufferGeometry`, `examples/js`: old habits | 97 rules pinned to the installed release flag each line with the fix; `fix` does the 23 pure renames |
| calls an API | guesses a name or an import path from memory | `three_api` reads `node_modules/three`: signature, deprecation and the right `three/addons/...` path |
| writes a shader | `#include <encodings_fragment>`, `gl_FragColor` with GLSL3, a `.replace()` on a chunk that is gone | includes checked against the installed `ShaderChunk`, patches that silently do nothing found, renames fixed |
| loads a model | `/models/Car.glb` that is a 404 on Linux, Draco without a decoder | `three_assets` resolves every path like the server does and names the missing decoder setup |
| says "it works" | never opened the page | `three_check` opens it headless: errors with causes, blank frames, a screenshot, baselines |
| gets a black screen | guesses: more light? move the camera? | `three_inspect` reads the live scene and says why each object is not visible |
| fixes a bug | cannot show it was there, or that it is gone | `three_play` runs steps and judges claims frame by frame; `three_scenario` keeps it as a regression test |
| makes it fast | changes things and hopes | `three_perf` counts draw calls, triangles and programs against a budget and the last run; `three_leaks` names what is never disposed |
| ships it | builds once, deploys, sees a 404 | `three_build` builds, finds two copies of three, missing assets and sub-path URLs, then opens the built page |
| needs a 3D model | needs Blender or a placeholder cube | `three_model_build` makes a clean `.glb` from one of 60 kinds, then shows it as text views and lints it |
| does not know the project | reads twenty files | `three_scan` and `three_doctor` give the map and the order to fix things in one call |

<p align="center">
  <a href="https://laaielichter.github.io/Threesmith/models.html"><img src="docs/gallery/overview.jpg" alt="Cars, aircraft, boats, buildings, trees and a dragon built by Threesmith and rendered by three.js" width="860"></a><br>
  <sub>3D models from code, no Blender: 60 ready-made kinds, rendered here by three.js itself. <a href="https://laaielichter.github.io/Threesmith/models.html">See all</a></sub>
</p>

## Quickstart

**1. See what is wrong.** Nothing to install but the package:

```sh
npx -y threesmith doctor          # what is wrong, grouped by cause, most urgent first, with next steps
npx -y threesmith review          # score 0-100, `file:line severity [rule] message Fix: ...`
npx -y threesmith check .         # open the page headless, errors and a screenshot
```

**2. Give it to your agent.** In Claude Code:

```text
/plugin marketplace add laaielichter/Threesmith
/plugin install threesmith@threesmith
```

**3. Ask for something.** *"Find out why the scene is black and fix it."* Every three.js file Claude edits is reviewed
right after the edit, its errors and broken asset paths go straight back to Claude, and the session starts with a
brief of the project.

## Install in your agent

| Client | How |
| --- | --- |
| **Claude Code** | `/plugin install threesmith@threesmith` after `/plugin marketplace add laaielichter/Threesmith` (MCP server, hooks incl. protected paths, 8 skills, 2 subagents, settings for tool sets and read-only) |
| **Claude Code, MCP only** | `claude mcp add threesmith -- npx -y threesmith mcp` |
| **Codex** | `codex mcp add threesmith -- npx -y threesmith mcp --tier premium` |
| **Cursor, VS Code** | the buttons at the top |
| **Gemini CLI** | `gemini extensions install https://github.com/laaielichter/Threesmith` |
| **Claude Desktop** | `npm run build:mcpb` makes `build/threesmith.mcpb` (attached to releases) |
| **Cline and others** | [llms-install.md](llms-install.md), or `{ "mcpServers": { "threesmith": { "command": "npx", "args": ["-y", "threesmith", "mcp"] } } }` |
| **Docker** | `Dockerfile` |

Run the agent from the project folder, or pass `--project <path>`. Needs Node.js 22.12+ and `three` installed in the
project. The browser tools need `playwright-core` and a Chromium (`npx playwright-core install chromium`);
`threesmith doctor --env` shows what is missing.

### Made for agents: cheap calls, exact answers

- **Two profiles.** `--tier cheap` (the default) gives short, capped output and numbered step-by-step instructions, so
  small models follow the right order; `--tier premium` gives full detail for large models.
- **Tool sets.** `--tools core` loads 14 tools; add `run`, `live`, `build`, `model` when you need them, or name single
  tools. A tool list the client pays for in every turn stays small. The server instructions only ever name tools
  that are loaded.
- **Fix loops that cost less.** `three_review` with `only_new: true` shows new findings in full, the ones the agent
  already saw as one short line, and how many are fixed. `code` + `file` reviews code before it is saved.
- **Structured results.** Review, check and doctor return `structuredContent` with an output schema next to the text.
- **One line per finding.** `file:line severity [rule] message Fix: ...`, the same in the CLI (`--compact`), MCP and hooks.
- **Safe writes.** Every write (fix, model build, scenario save) is one journal entry that `three_undo` takes back; a
  file changed by hand since is left alone. `"protect"` in `threesmith.json` (or `THREESMITH_PROTECT`) names
  folders no write may touch. `--read-only` leaves out the tools that always write and refuses write options.
- **It learns, locally.** A finding marked as a false alarm with `three_feedback` is hidden from then on; lessons kept
  with `three_lesson_add` come back under the same error. Only hashes, counters and scrubbed text, on this machine.

## The 31 tools

<details open>
<summary>All MCP tools (most are also CLI commands)</summary>

| Set | Tool | What it does |
| --- | --- | --- |
| core | `three_doctor` | Start here when something is broken: versions and imports, why the scene shows nothing, assets that will not load, removed APIs, colour, performance and cleanup, grouped by cause, most urgent first, with what `three_fix` does and numbered next steps |
| core | `three_scan` | Map the project: bundler and framework, three vs `@types/three` vs package.json, the libraries around it, pages and import maps, every file that uses three with what it creates and where its loop is, renderer settings, assets |
| core | `three_api` | Exact API of a class, member or constant in the installed three: signature, deprecation, import path; did-you-mean for unknown names |
| core | `three_search` | Find classes, constants and members by part of a name |
| core | `three_review` | Scored review (0-100) with 97 rules pinned to the installed release; `code` + `file` for unsaved code, `only_new` in a fix loop, `files` to focus |
| core | `three_types` | The project's own `tsc --noEmit`, with each three.js type error answered from the installed release (the member that exists, the real import path) |
| core | `three_fix` | The renames that mean exactly the same, dry run first, undoable |
| core | `three_explain` | Cause and fix of a console, build or test message (35 kinds), with the right import path for the installed release |
| core | `three_lessons` | 100 lessons from real three.js and react-three-fiber projects (symptom, cause, fix, test) by error message, words, rule or topic |
| core | `three_lesson_add` | Keep a lesson learned here, scrubbed of names, paths and code; it comes back under the same error |
| core | `three_rules` | Every review rule with its category, release gating and fix |
| core | `three_feedback` | Mark a finding as a false alarm (hidden from then on) or right |
| core | `three_undo` | Undo the last Threesmith writes, newest first |
| core | `three_version` | Which three release is installed |
| run | `three_check` | Headless Chromium (software WebGL 2): console and page errors with causes, shader errors at your file and line, failed requests, no context, lost context, blank frames, screenshot, baselines with a diff, interaction steps |
| run | `three_inspect` | The live scene graph, camera, draw calls, GPU memory growth, and why each object is not visible |
| run | `three_play` | Steps (click, press, hold, drag, wheel, frames, eval, until), watched values per frame and step, claims judged at the end, any moment or every frame |
| run | `three_scenario` | Keep a passing play run as a regression test in `.threesmith/scenarios/`; `ci` runs them and writes JUnit |
| run | `three_perf` | Draw calls, triangles, programs, geometries, textures (exact) and frame-time percentiles with the slowest frames and their cause, against a budget and the last run |
| run | `three_leaks` | Repeat a cycle of steps with garbage collection and report what grows per cycle, down to the GPU resources never disposed, by type |
| live | `three_session` | Keep a headless page open between calls (start, status, stop) |
| live | `three_page` | Drive that page without reloading: eval JS against the live scene, steps, frames, until, screenshot, inspect, reload, new errors after every answer |
| build | `three_assets` | Every asset path resolved like the dev server and a static host: missing files, wrong capitals, decoder folders, glTF decoders the code never sets up, huge textures, unused files |
| build | `three_build` | Run the build, check the output (copies of three, missing assets, sub-path URLs, decoders) and open the built page headless |
| model | `three_model_brief` | One page before you build a model: the nearest ready-made kind, parts, real size, rules, the order of tools |
| model | `three_model_identify` | What a thing is (English or Dutch): parts, pivots, typical size, variants, usual mistakes |
| model | `three_model_spec` | The JSON model spec, an example, and the 60 ready-made kinds |
| model | `three_model_build` | Build a clean, deterministic `.glb` from a kind or a spec, and lint it |
| model | `three_model_view` | A `.glb` as text: front, side and top views, parts with sizes, parts that do not touch |
| model | `three_model_lint` | Score a `.glb` for the web (geometry, materials, triangles, draw calls, texture memory, loading), and against what it should be |
| model | `three_model_inspect` | What is in a `.glb` and which loaders and decoders three.js needs, with the setup code, checked against the project's code |

</details>

CLI: `threesmith doctor | scan | api | search | review | types | fix | rules | undo | lessons | assets | check |
inspect | play | scenario | perf | leaks | build | model <inspect|needs|view|lint|identify|brief|spec|kinds|recipes|build>
| explain | ci | hook | mcp`. `threesmith <command> --help` lists the options.

### The review

Rules are pinned to the installed release: a removed API is an **error** on a release that removed it and a warning on
an older one; a rule whose replacement does not exist yet in your release stays quiet. The categories:

- **api** (28): removed or renamed APIs and their releases, symbols that do not exist in the installed version, TSL
  names imported from the wrong entry, `three/src` imports, deprecations read from three's own source.
- **correctness** (48): code that renders nothing or the wrong thing — no lights, shadows off, renderer never attached,
  `render(camera, scene)`, `scene.add(gltf)`, a mixer never updated, `getElapsedTime()` and `getDelta()` on one clock,
  instance and attribute updates without `needsUpdate`, raycasting with window instead of canvas coordinates, controls
  bound to `document`, decoders created but never attached; shaders: `#include` chunks that do not exist in the
  installed release, `onBeforeCompile` patches that do nothing, GLSL3 mistakes, redeclared built-ins, uniforms
  without `{ value }`, GLSL materials under WebGPU and node materials under WebGL; React Three Fiber: state set in
  `useFrame`, objects made in render.
- **performance** (10): allocations and heavy objects per frame, scene traversal per frame, uncapped pixel ratio, huge
  shadow maps, many meshes that should be instanced.
- **lifecycle** (3): no resize handling, removed objects never disposed, `dispose()` without `super.dispose()`.
- **color** (8): colour textures without `colorSpace`, colour management off, EffectComposer without OutputPass or with
  double gamma, `envMapIntensity` that has no effect.

It reads text, not types (`three_types` adds the type checker for TypeScript). The rules are tested against three's
own examples and addons for false alarms. If a finding is wrong: `three_feedback`, `--disable <rule>`, or
`// threesmith-disable-next-line <rule>` (also `-disable-line`, `-disable-file`); an issue with the snippet is the most
useful bug report.

### GitHub Action

```yaml
- uses: laaielichter/Threesmith@main
  with:
    min-score: 85
    check: dist          # folder with the built index.html; omit to skip the browser
    baseline: home       # screenshot baseline in .threesmith/baselines/home.png
    comment: true        # post the receipt on the pull request
```

The receipt (review, check, scenarios) appears in the job summary and optionally as a PR comment. Locally or in any
CI: `threesmith ci --check dist --junit junit.xml --sarif threesmith.sarif`. Commit `.threesmith/baselines/` and
`.threesmith/scenarios/`; the rest of `.threesmith/` is local state and ignored by its own `.gitignore`.

## Limits

- **WebGL 2** in headless Chromium works in GitHub Actions (SwiftShader software rendering). **WebGPU** is best effort
  (`--webgpu`), depending on the runner having an adapter.
- Frame times come from software rendering: compare them before and after on the same machine. Draw calls, triangles,
  programs and resource counts are exact.
- Baselines should be made in the environment that checks them (CI), with the default tolerance.
- The API lookup parses the JSDoc in `three/src`; it is tested on r187, older releases give thinner answers.
- The review is heuristic; the asset check follows paths written as text, not paths built at run time.

## Benchmarks

`bench/` has tasks and a deterministic grader for comparing an agent with and without Threesmith. No results are
published yet; see `bench/README.md` for the method.

## Develop

```sh
npm ci
npm run check     # typecheck, tests (incl. headless Chromium), build
```

See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Threesmith follows the design of its sister
project for Godot, [Godotwright](https://github.com/laaielichter/Godotwright). MIT licensed, made by laaielichter.
