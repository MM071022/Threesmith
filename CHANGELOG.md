# Changelog

## 0.1.0

First version.

- `threesmith api` / `search`: API lookup pinned to the installed three.
- `threesmith review`: scored review, 39 rules, symbol validation.
- `threesmith check`: headless WebGL 2 check with screenshot baselines.
- `threesmith ci`, GitHub Action, MCP server (`three_api`, `three_search`, `three_review`, `three_check`, `three_version`).
- `threesmith fix` / `three_fix`: mechanical renames, dry run unless `--write`.
- Inline `// threesmith-disable-next-line|-line|-file [rule]` comments.
- `check --steps` / `steps` in `three_check`: click, press, drag, wheel, wait, wait-for before the screenshot.
- Install buttons (VS Code, Cursor) in the README and on the site.
- Benchmark tasks and grader (no results yet).
- Claude Code plugin (skill, `three-reviewer` agent, hooks that review edited files), Claude Desktop bundle, Gemini CLI extension, Dockerfile, `llms-install.md`, `threesmith doctor`, `mcp --project`.
- Release and publish workflows (npm trusted publishing, MCP registry), CodeQL, Dependabot, project site in `docs/`.

Packaging, hooks, workflows and community files are adapted from Godotwright.
