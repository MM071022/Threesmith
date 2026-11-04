# Changelog

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
