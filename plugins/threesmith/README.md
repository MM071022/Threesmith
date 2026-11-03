# Threesmith plugin for Claude Code

Adds the Threesmith MCP server (`three_api`, `three_search`, `three_review`, `three_check`, `three_version`), a skill
that tells Claude when to use them, a `three-reviewer` agent, and hooks:

- after Claude edits a three.js file, the file is reviewed and errors go back to Claude;
- command output with three.js problems (removed APIs, wrong import paths) gets a pointer to `three_api`;
- Claude is told once about review errors still open before it stops;
- a session in a three.js project starts with the installed version.

Install:

```
/plugin marketplace add laaielichter/Threesmith
/plugin install threesmith@threesmith
```

`THREESMITH_HOOKS=0` turns the hooks off. Hooks fail open: if Threesmith cannot run, they say nothing.
The plugin runs `npx threesmith@<version>`, so the package must be on npm (see the repository README).
