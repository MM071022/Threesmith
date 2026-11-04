# Threesmith plugin for Claude Code

Adds the Threesmith MCP server (31 tools: `three_doctor`, `three_scan`, `three_api`, `three_review`, `three_check`,
`three_inspect`, `three_play`, `three_assets`, `three_model_build` and more; see the repository README), and:

- **Skills:** `threesmith` (when to use which tool), `debug`, `perf`, `review`, `upgrade`, `ship`, `model`, `learn`.
- **Subagents:** `three-reviewer` (verified review of a change) and `three-debugger` (root cause of a broken scene,
  without flooding the main conversation with logs).
- **Hooks:**
  - before Claude edits a file, an edit into a protected path is refused (a `threesmith.json` `"protect"` list, or
    the protect setting below), and so is an edit of the protect list itself;
  - after Claude edits a three.js file, it is reviewed; errors and asset paths that will not load go back to Claude;
  - command output with three.js problems gets the cause, the fix and the lessons that explain it;
  - Claude is told once about review errors still open before it stops;
  - a session in a three.js project starts with the installed version and a short project brief.

Install:

```
/plugin marketplace add laaielichter/Threesmith
/plugin install threesmith@threesmith
```

**Settings** (asked when you enable the plugin): the project folder, protected paths, tool sets (`core`, `run`,
`live`, `build`, `model`; empty means all 31) and read-only. The server runs with `--tier premium` (full detail).

`THREESMITH_HOOKS=0` turns the hooks off. Hooks fail open: if Threesmith cannot run, they say nothing.
The plugin runs `npx threesmith@<version>`, so the package must be on npm (see the repository README).
