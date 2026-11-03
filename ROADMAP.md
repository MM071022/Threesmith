# Roadmap

Done in 0.1.0 (each has tests):

- [x] Version-pinned API lookup and search from the installed three (`api`, `search`, MCP).
- [x] Scored review with 39 rules, release-gated, symbol validation against the installed exports.
- [x] Headless WebGL 2 check: errors, blank frames, context loss, screenshot, baselines with diff image.
- [x] MCP server (5 tools), CLI, `ci` receipt, GitHub Action, agent skill.
- [x] `fix` for mechanical renames and inline disable comments.
- [x] Claude Code plugin with hooks, Claude Desktop bundle, Gemini extension, Docker, `doctor`.
- [x] Benchmark tasks and a model-free grader.

Next:

- [ ] Publish to npm and the MCP registry; add the Action to the marketplace.
- [ ] Run the benchmark with real agents (N >= 10 per arm) and publish outputs and results.
- [ ] Type-aware review for TypeScript projects (use the TypeScript checker for `@types/three` mismatches).
- [ ] More rules from the migration guide: renderer/WebGPU migration, TSL, post-processing changes.
- [ ] Best-effort WebGPU runs on runners with a usable adapter; GPU-based baselines.
- [ ] Interaction scripts for `check` (click, drag, wait for an event) before the screenshot.
