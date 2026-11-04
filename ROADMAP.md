# Roadmap

Done in 0.1.0 (each has tests):

- [x] Version-pinned API lookup and search from the installed three (`api`, `search`, MCP).
- [x] Scored review with 39 rules, release-gated, symbol validation against the installed exports.
- [x] Headless WebGL 2 check: errors, blank frames, context loss, screenshot, baselines with diff image.
- [x] MCP server, CLI, `ci` receipt, GitHub Action, agent skill.
- [x] Interaction steps for `check`.
- [x] `fix` for mechanical renames and inline disable comments.
- [x] Claude Code plugin with hooks, Claude Desktop bundle, Gemini extension, Docker, `doctor`.
- [x] Benchmark tasks and a model-free grader.

Done since (unreleased, each has tests):

- [x] Doctor grouped by cause and project map (`three_doctor`, `three_scan`).
- [x] Tool sets, cheap and premium profiles, read-only mode, structured results.
- [x] Review: 97 rules incl. shaders against the installed ShaderChunk, R3F, loaders; only_new, unsaved code, SARIF.
- [x] Type-aware review for TypeScript projects (`three_types`, the project's own tsc).
- [x] Lessons from real projects and local lessons; false-alarm feedback.
- [x] Asset check (paths, case, decoders); build check of the deployed output.
- [x] Play with claims, scenarios as regression tests (JUnit), perf budgets, leak cycles.
- [x] A live headless page between calls (`three_session`, `three_page`).
- [x] 3D models without Blender: build, view as text, lint, inspect with loader needs.
- [x] Undo journal for every write, protected paths.

Next:

- [ ] Publish to npm and the MCP registry; add the Action to the marketplace.
- [ ] Run the benchmark with real agents (N >= 10 per arm) and publish outputs and results.
- [ ] More rules from the migration guide as three releases (each verified in the source).
- [ ] Best-effort WebGPU runs on runners with a usable adapter; GPU-based baselines.
- [ ] Lessons gaps: list the errors seen here that no rule or lesson explains yet.
