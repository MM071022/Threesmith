# Changelog

## Unreleased

- **50 new ready-made 3D models, 110 in all**, each an adjustable blueprint with 5 to 12 parameters (sizes, counts,
  styles, optional parts, colours, seeds) and pivots on the parts that move, linting 100/100 against what it should be:
  - vehicles and vessels: ambulance, fire truck, forklift, excavator, tram, go-kart, horse-drawn carriage, submarine,
    hovercraft, Viking longship;
  - air, space and machines: hot-air balloon, airship (zeppelin or steampunk), seaplane, space station, lunar lander,
    Mars rover, mech walker, robot, vending machine, arcade cabinet;
  - buildings and street: lighthouse, gas station, wizard tower, tavern, market stall, water tower, greenhouse,
    bus stop, fire hydrant, well;
  - items and furniture: sword, shield, battle axe, potion bottle, treasure chest, lantern, teapot, sofa, bookshelf,
    grandfather clock;
  - nature and creatures: cactus, mushroom, crystal cluster, boulder, birch, dog, cow, deer, snowman, stone golem.
- **Blueprints are easier to adapt:** `"visible"` leaves a part out, enum params work in expressions (`$style`,
  `$style_military`), `"material": "paint_{colour}"` picks a material by param, and `repeat` takes a count of 0.
- "lighthouse", "water tower" and "tram" now name their own archetypes instead of the generic tower and train.
- Security and robustness fixes from code scanning: step and watch code reaches the page as data instead of being
  pasted into a script, files are read and created without a check-then-use gap (undo journal, review memory,
  `.threesmith/.gitignore`), lesson placeholders are removed until none is left, Markdown escaping in the CI receipt
  escapes backslashes too, and the import-map rule reads `</script >` in any case.

## 0.2.0

The agent-first toolkit of Godotwright (the same project for Godot), ported to three.js and extended with what coding
agents get wrong in three.js.

- **Start here:** `three_doctor` (also `threesmith doctor`) groups the problems of a project by cause, most urgent
  first, with what `three_fix` does and numbered next steps; `three_scan` maps the stack, versions, pages, the files
  that use three, renderer settings and assets in one call. The session-start hook gives a short brief of it.
- **Review:** 97 rules (was 39), pinned to the installed release. New: shaders checked against the installed
  `ShaderChunk` (unknown includes, `onBeforeCompile` patches that do nothing, GLSL3 mistakes, built-ins redeclared,
  uniforms without `{ value }`, GLSL under WebGPU, node materials under WebGL), loaders and decoders, TSL import paths,
  import maps, controls, animation mixers and clocks, instance and attribute updates, raycasting coordinates, render
  argument order, `scene.add(gltf)`, colour and post-processing (OutputPass, double gamma), deprecations read from
  three's source, and React Three Fiber (state in `useFrame`, objects in render, render priority). `fix` does 23
  rules. 17 new `explain` patterns (35 in all).
- **Fix loops that cost less:** `three_review` takes unsaved `code` + `file`, `only_new` (new findings in full, seen
  ones as a short line, the number fixed) and `files`; one line per finding (`--compact` on the CLI); SARIF output.
- **`three_types`:** the project's own `tsc --noEmit`, each three.js type error answered from the installed release.
- **Lessons:** 100 lessons from real three.js and react-three-fiber projects, by error message, words, rule or topic
  (`three_lessons`, `threesmith lessons`), shown under review, check, explain, doctor and hook output;
  `three_lesson_add` keeps one learned here, scrubbed of names, paths and code.
- **Assets:** `three_assets` resolves every path in the code like the dev server and a static host do: missing files,
  paths that only work on a case-insensitive disk, decoder folders, glTF files that need a decoder the code never
  sets up, textures above 4096, unused files. The edit hook names broken paths right after an edit.
- **Prove it:** `three_play` (steps, watched values per frame, claims judged at the end, any moment or every frame),
  `three_scenario` (passing runs kept as regression tests; `ci` runs them and writes JUnit), `three_perf` (draw
  calls, triangles, programs, textures and frame times against a budget and the last run), `three_leaks` (what grows
  per cycle, down to the GPU resources never disposed, by type).
- **Live page:** `three_session` and `three_page` keep a headless page open between calls: eval against the live
  scene, steps, frames, until, screenshots, inspect, reload, new errors after every answer.
- **Ship:** `three_build` runs the build, checks the output (copies of three, missing assets, sub-path URLs,
  decoders) and opens the built page headless.
- **3D models without Blender:** `three_model_build` builds clean, deterministic `.glb` files from 110 kinds or a JSON
  spec; `three_model_view` draws them as text; `three_model_lint` scores them for the web and against 129 archetypes;
  `three_model_inspect` says which loaders and decoders three.js needs and checks the code sets them up.
- **For agents and teams:** tool sets (`--tools core` loads 14 tools), `--tier cheap|premium`, `--read-only`,
  structured results, server instructions that name only loaded tools, an undo journal for every write
  (`three_undo`), protected paths, and false-alarm feedback that hides a finding on this machine.
- **Plugin:** a pre-edit hook that refuses Claude's edits into protected paths (and of the protect list); settings
  for protected paths, tool sets and read-only; full-detail profile; an icon; passes `claude plugin validate`. Skills `debug`, `perf`, `review`, `upgrade`, `ship`, `model`, `learn`; a `three-debugger` subagent.
- CLI output falls back to plain ASCII on a Windows pipe, where PowerShell turned `✖` into `Ôƒû` (`THREESMITH_ASCII`).
- Fixed: the API lookup found no members for classes re-exported through a local export list (every material).

## 0.1.0

First version.

- `threesmith api` / `search`: API lookup pinned to the installed three.
- `threesmith review`: scored review, 39 rules, symbol validation.
- `threesmith check`: headless WebGL 2 check with screenshot baselines.
- `threesmith ci`, GitHub Action, MCP server (`three_api`, `three_search`, `three_review`, `three_fix`, `three_check`, `three_inspect`, `three_explain`, `three_version`).
- `threesmith fix` / `three_fix`: mechanical renames, dry run unless `--write`.
- Inline `// threesmith-disable-next-line|-line|-file [rule]` comments.
- `check --steps` / `steps` in `three_check`: click, press, drag, wheel, wait, wait-for before the screenshot.
- Install buttons (VS Code, Cursor) in the README and on the site.
- `threesmith inspect` / `three_inspect`: the live scene graph, camera and renderer stats from the running page, with a
  diagnosis of why objects are not visible, and GPU memory sampled twice to catch leaks. `check --inspect` adds it to a
  check, and a blank frame gets it automatically.
- `threesmith explain` / `three_explain`: cause and fix for 18 kinds of three.js runtime errors, with the right import
  path for the installed version. `check` attaches it to every console error.
- Shader compile errors in `check` are parsed and pointed at the file and line in your project.
- The Claude Code hook explains three.js errors in command output.
- Benchmark tasks and grader (no results yet).
- Claude Code plugin (skill, `three-reviewer` agent, hooks that review edited files), Claude Desktop bundle, Gemini CLI extension, Dockerfile, `llms-install.md`, `threesmith doctor`, `mcp --project`.
- Release and publish workflows (npm trusted publishing, MCP registry), CodeQL, Dependabot, project site in `docs/`.

Packaging, hooks, workflows and community files are adapted from Godotwright.
