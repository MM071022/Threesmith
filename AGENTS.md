# AGENTS.md

Guide for coding agents working on this repository.

## What this is

Threesmith is a CLI and MCP server that makes coding agents better at three.js (the three.js counterpart of Godotwright): an offline API lookup pinned to the
installed three version, a scored review, a headless WebGL check with screenshot baselines, and a CI receipt.
See `ROADMAP.md` for the plan.

## Commands

```sh
npm ci              # install exact dependencies (three is a devDependency, used by tests)
npm run typecheck   # tsc, no output files
npm test            # vitest (the headless tests need Chromium; they skip without it)
npm run build       # compile src/ to dist/
npm run check       # all of the above, run this before every commit
node dist/cli.js --help
```

## Layout

- `src/cli.ts`: executable entry (`threesmith` bin). Keep it tiny. `src/program.ts` builds the commander program.
- `src/api/`: the API index. `install.ts` finds `node_modules/three`, `index-builder.ts` maps public exports to files
  and parses classes, members and constants from the JSDoc in `three/src`, `lookup.ts` does lookup, search and
  did-you-mean, `jsdoc.ts` parses doc blocks.
- `src/review/`: `source.ts` reads files (comments blanked, imports parsed), `rules.ts` builds `RULES` from its own
  rules plus `shader-rules.ts` and `scene-rules.ts` (`parse.ts` holds the shared helpers and the tables read from the
  installed three: shader chunks, exports), `review.ts` runs them, gates them by the installed release and scores
  (`overrides` reviews unsaved code), `format.ts` and `compact.ts` print, `delta.ts` is the only_new memory,
  `sarif.ts` the SARIF output, `fix.ts` applies the mechanical renames (a rule that gets a fix needs a case in
  `test/fix.test.ts`). Every rule has a firing and a quiet case in `test/rules.cases.ts`.
- `src/scan/`: `scan.ts` is the project map, `assets.ts` resolves asset paths and decoders. `src/doctor/triage.ts` is
  `three_doctor` (groups by cause); `doctor.ts` is the environment check.
- `src/types/types.ts`: runs the project's tsc and answers three.js type errors from the API index.
- `src/lessons/`: `data/lessons.json` (bundled lessons), `search.ts`, `local.ts` (lessons kept on this machine),
  `anonymize.ts` (bundled lessons must pass it unchanged; `test/lessons.test.ts` checks it), `hints.ts`, `format.ts`.
- `src/learn/feedback.ts`: false-alarm feedback (hashes and counters only) in `$THREESMITH_HOME`.
- `src/project/journal.ts`: every write Threesmith makes to a project goes through `writeFiles`/`JournalWriter`
  (undo, protected paths from `protect.ts`). Never `writeFileSync` into a project from a tool.
- `src/check/`: besides `check.ts`: `page.ts` opens a page, `steps.ts` runs steps, `runtime.ts` is the in-page code
  (`window.__threesmith`, frame recorder, dispose tracker), `play.ts`, `scenario.ts`, `perf.ts`, `leaks.ts`, `build.ts`.
- `src/session/session.ts`: the live page kept between calls (`three_session`, `three_page`).
- `src/model/`, `src/archetype/`, `src/build/` with `data/archetypes/` and `data/recipes/`: glTF inspect, text views,
  lint, loader needs (`needs.ts`), "what a thing is", and the `.glb` builder (pure: it returns bytes, the caller writes
  through the journal). `src/model/index.ts` is the API the CLI and MCP use.
- `src/mcp/`: `server.ts` registers tools with `tool(...)` (never `server.registerTool`); every tool is in one set in
  `toolsets.ts` (`--tools`, `--read-only`), `instructions.ts` holds the cheap and premium instructions (filtered by the
  enabled tools), `structured.ts` the output schemas. README, skills and agents may only name tools that exist;
  `test/manifests.test.ts` checks it.
- `src/check/`: `check.ts` is the headless run (Playwright, SwiftShader WebGL, console/page/request errors, blank
  detection, baselines), `png.ts` and `diff.ts` the pixel work, `server.ts` the static server, `browser.ts` flags and
  Chromium discovery.
- `src/check/inspect.ts`: the scene inspector that runs in the page (devtools hook, visibility diagnosis); a new
  diagnosis needs a case in `test/inspect.test.ts`. `src/explain/`: error explanations (`explain.ts`, a pattern needs a
  case in `test/explain.test.ts`) and `locate.ts`, which finds a shader line in the project.
- `src/ci.ts`: the receipt (review, check, scenarios). `action.yml`: the GitHub Action. `test/setup.ts` points
  `THREESMITH_HOME` at a temp folder, so tests never touch the real learning and lessons files.
- `src/hooks/hooks.ts`: Claude Code hooks (`threesmith hook <event>`), run by `plugins/threesmith/hooks/run.mjs`. They fail open.
  `src/doctor/`: `threesmith doctor`.
- `scripts/sync-version.mjs` copies the package version into the manifests (`test/manifests.test.ts` checks it);
  `scripts/build-mcpb.mjs` builds the Claude Desktop bundle.
- `docs/`: the GitHub Pages site. `scripts/site.mjs` fills its terminal blocks with real CLI output on
  `examples/agent-mistakes`, `scripts/gallery.mjs` renders models with three.js into `docs/gallery/`,
  `scripts/models-page.py` writes `models.html`, `scripts/og.mjs` renders `og.png`. Keep claims in sync with the README;
  `test/examples.test.ts` checks the numbers the site states.
- `bench/`: tasks and a model-free grader. `plugins/threesmith/`: the Claude Code plugin (skill, reviewer agent, hooks); `.claude-plugin/` is its marketplace.

## Rules for changes

- A new review rule needs a test in `test/review.test.ts` that fires and a case that stays quiet. It must also keep
  `test/review.test.ts` "no false alarms on three's own addons" green.
- State a release number on a rule (`removedIn`, `introducedIn`, `deprecatedIn`) only when you verified it in the
  three changelog/migration guide or the source. Leave it out when unsure.
- Never claim benchmark numbers that were not measured.
- Output meant for agents is compact and stable: one line per finding, capped lists, numbers rounded. Never write to stdout in code the MCP server runs.
- Commit as `laaielichter <laaielichter@users.noreply.github.com>`; see `CLAUDE.md`.
