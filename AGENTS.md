# AGENTS.md

Guide for coding agents working on this repository.

## What this is

Threesmith is a CLI and MCP server that makes coding agents better at three.js: an offline API lookup pinned to the
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
- `src/review/`: `source.ts` reads files (comments blanked, imports parsed), `rules.ts` holds every rule,
  `review.ts` runs them, gates them by the installed release and scores, `format.ts` prints.
- `src/check/`: `check.ts` is the headless run (Playwright, SwiftShader WebGL, console/page/request errors, blank
  detection, baselines), `png.ts` and `diff.ts` the pixel work, `server.ts` the static server, `browser.ts` flags and
  Chromium discovery.
- `src/mcp/server.ts`: MCP tools. `src/ci.ts`: the receipt. `action.yml`: the GitHub Action.
- `src/hooks/hooks.ts`: Claude Code hooks (`threesmith hook <event>`), run by `plugins/threesmith/hooks/run.mjs`. They fail open.
  `src/doctor/`: `threesmith doctor`.
- `scripts/sync-version.mjs` copies the package version into the manifests (`test/manifests.test.ts` checks it);
  `scripts/build-mcpb.mjs` builds the Claude Desktop bundle.
- `bench/`: tasks and a model-free grader. `plugins/threesmith/`: the Claude Code plugin (skill, reviewer agent, hooks); `.claude-plugin/` is its marketplace.

## Rules for changes

- A new review rule needs a test in `test/review.test.ts` that fires and a case that stays quiet. It must also keep
  `test/review.test.ts` "no false alarms on three's own addons" green.
- State a release number on a rule (`removedIn`, `introducedIn`, `deprecatedIn`) only when you verified it in the
  three changelog/migration guide or the source. Leave it out when unsure.
- Never claim benchmark numbers that were not measured.
- Commit as `laaielichter <laaielichter@users.noreply.github.com>`; see `CLAUDE.md`.
