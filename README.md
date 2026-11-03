# Threesmith

[![CI](https://github.com/laaielichter/Threesmith/actions/workflows/ci.yml/badge.svg)](https://github.com/laaielichter/Threesmith/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP_server-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=threesmith&config=%7B%22name%22%3A%22threesmith%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22threesmith%22%2C%22mcp%22%5D%7D)
[![Install in Cursor](https://img.shields.io/badge/Cursor-Install_MCP_server-000000?logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=threesmith&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInRocmVlc21pdGgiLCJtY3AiXX0%3D)
[![Add to Claude Code](https://img.shields.io/badge/Claude_Code-Add_plugin-D97757)](#add-it-to-your-agent)

**three.js for coding agents.** An MCP server and CLI that stops AI agents from writing outdated three.js and tells
them when a scene is broken.

three.js ships a release almost every month and removes old APIs. Models were trained on years of code that used
`THREE.Geometry`, `outputEncoding`, `three/examples/js`, `BoxBufferGeometry`, and import paths that no longer exist.
Threesmith checks the code against **the three version your project actually has installed**.

```sh
npm i -D threesmith          # or: npx threesmith ...
npx threesmith review        # scored review of the project
npx threesmith api Mesh      # exact API of the installed version
npx threesmith check .       # open the page in headless Chromium
```

## What it does

| Tool (MCP) | CLI | What you get |
| --- | --- | --- |
| `three_api` | `threesmith api WebGLRenderer.setSize` | Constructor, properties, methods, deprecations and the right import path, read from `node_modules/three` (no network, no stale training data). Unknown names get "did you mean". |
| `three_search` | `threesmith search orbit --members` | Find classes, constants and members by name. |
| `three_review` | `threesmith review [path]` | Score 0-100 (and grade) over five categories with file:line findings and a fix for each. |
| `three_fix` | `threesmith fix [path] --write` | Applies the renames that mean exactly the same (`BoxBufferGeometry` -> `BoxGeometry`, `THREE.Math` -> `MathUtils`, `applyMatrix` -> `applyMatrix4`, `three/examples/jsm` -> `three/addons`, `outputEncoding` -> `outputColorSpace`, capped pixel ratio). Dry run unless `--write`. |
| `three_check` | `threesmith check <folder\|url>` | Headless Chromium with software WebGL 2: console and page errors, failed requests, no canvas / no GL context, lost context, **blank frames**, three revision, screenshot, optional baseline compare. `--steps` clicks, presses keys, drags or scrolls first, so you can baseline a state after an interaction. |
| `three_version` | `threesmith api` | Which release is installed. |
| – | `threesmith doctor` | Checks Node, installed three, Playwright and a working headless WebGL. |
| – | `threesmith ci` | One markdown receipt (review + optional check) for CI. Fails on errors or a minimum score. |

### The review

Rules are pinned to the installed release: a removed API is an **error** on a version that removed it and a warning
on an older one; a rule whose replacement does not exist yet in your version stays quiet.

- **api**: removed or renamed APIs (`Geometry`, `Face3`, `XBufferGeometry`, `THREE.Math`, `outputEncoding`,
  `useLegacyLights`, `mergeBufferGeometries`, `examples/js`, `Clock` deprecation, ...), and **symbols that do not exist
  in the installed version** (typos, addons imported from `three`, `WebGPURenderer` imported from `three`, addon files
  that are not there).
- **correctness**: shadows requested but `shadowMap.enabled` off, lit materials with no light, camera `near = 0`,
  renderer never attached to the page, nothing ever calls `render()`, `aspect` changed without
  `updateProjectionMatrix()`, damping without `controls.update()`, WebGPU without `init()`, unpinned CDN, `three` and
  `@types/three` out of sync.
- **performance**: objects allocated every frame, geometry/material created inside the loop, scene traversal per
  frame, uncapped pixel ratio, huge shadow maps, hundreds of separate meshes instead of instancing.
- **lifecycle**: no resize handling, removed objects never disposed.
- **color**: color textures without `colorSpace`, color management switched off.

It is heuristic, not a type checker: it reads text, not types. If a finding is wrong, `--disable <rule>` skips a rule, or
`// threesmith-disable-next-line <rule>` (also `-disable-line`, `-disable-file`) skips it in the code,
and an issue with the snippet is the most useful bug report. Every rule has a test.

### Add it to your agent

```sh
# Claude Code: the plugin also adds a skill, a reviewer agent and hooks
/plugin marketplace add laaielichter/Threesmith
/plugin install threesmith@threesmith

# Claude Code: MCP server only
claude mcp add threesmith -- npx -y threesmith mcp
```

The hooks review every three.js file Claude edits and send the errors back, point at `three_api` when a build prints a
removed API or a wrong import, and name errors still open before Claude stops. `THREESMITH_HOOKS=0` turns them off.
Claude Desktop: `npm run build:mcpb` makes `build/threesmith.mcpb` (attached to releases). Gemini CLI:
`gemini-extension.json`. Cline and other agents: [llms-install.md](llms-install.md). Docker: `Dockerfile`.
`threesmith doctor` shows what is missing (three, Playwright, Chromium with WebGL).

Generic MCP config:

```json
{ "mcpServers": { "threesmith": { "command": "npx", "args": ["-y", "threesmith", "mcp"] } } }
```

`plugins/threesmith/skills/threesmith/SKILL.md` is an agent skill that tells the agent when to call each tool.

### GitHub Action

```yaml
- uses: laaielichter/Threesmith@main
  with:
    min-score: 85
    check: dist          # folder with the built index.html; omit to skip the browser
    baseline: home       # screenshot baseline in .threesmith/baselines/home.png
    comment: true        # post the receipt on the pull request
```

The receipt appears in the job summary and (optionally) as a PR comment; screenshots and diffs are uploaded as an
artifact. Commit the baseline images; update them with `threesmith check ... --update-baseline`.

## Limits

- **WebGL 2** in headless Chromium works in GitHub Actions (SwiftShader software rendering). **WebGPU** is best effort
  (`--webgpu`): it depends on the runner having a usable adapter, and `three_check` reports whether one exists.
- Software rendering differs slightly from real GPUs, so baselines should be made in the same environment that checks
  them (CI), with the default tolerance.
- The API lookup parses the JSDoc in `three/src`. It is tested on r187; older releases have less complete JSDoc, so results there are thinner.
- The browser check needs `playwright-core` and a Chromium (`npx playwright-core install chromium`).
- Not yet published to npm: until then run it from this repo (`npm ci && npm run build`).

## Benchmarks

`bench/` has five tasks and a deterministic grader for comparing an agent with and without Threesmith. No results are
published yet; see `bench/README.md` for the method and its limits.

## Develop

```sh
npm ci
npm run check     # typecheck, tests (incl. headless Chromium), build
```

See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed, made by laaielichter.
