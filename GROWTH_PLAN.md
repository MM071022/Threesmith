# Growth plan

How Threesmith gets found and used: a strong page first, one launch, then a steady trickle from listings.
No bought stars, no upvote requests, no alt accounts, and "I built this" in every post.

## Status (4 Nov 2026)

- **Ready on branch `claude/ecstatic-darwin-1xbuf6`, not released:** 31 MCP tools (was 8), 97 review rules, 100
  lessons, the live page, play/scenarios/perf/leaks/build, 3D models. Everything is in the changelog under Unreleased.
- **Site** (`docs/`, deployed by the Pages workflow on a push to `main`): home page with real output of the doctor,
  fix and check on `examples/agent-mistakes`, before/after screenshots, a gallery rendered by three.js itself, an
  install page for every client, a models page, `og.png`, sitemap, structured data, light and dark mode, no
  horizontal scroll at 390 px.
- **README:** centered header with logo, before/after image, gallery, without/with table, all 31 tools.
- **Regenerate** after changes: `npm run build`, then `node scripts/site.mjs` (terminal blocks),
  `node scripts/gallery.mjs` (renders), `python3 scripts/models-page.py <kinds.json>`, `node scripts/og.mjs`.
  `test/examples.test.ts` keeps the numbers the site states true.

## Readiness gate

- [x] Real demo (before/after of a real run, real terminal output on the site)
- [x] Copy-paste quickstart and one-step installs (plugin, Cursor, VS Code, Codex, Gemini CLI, `.mcpb`)
- [x] Social preview image (`docs/og.png`); upload it by hand (below)
- [ ] First release on npm (the plugin, the Gemini extension and the bundle start `threesmith@<version>`)
- [ ] 3-5 good first issues (drafts below)
- [ ] A launch day when you can answer comments for 6-8 hours

## Manual to-dos (only you can do these)

1. **Merge** the branch into `main` (the site deploys on that push; check Settings > Pages is set to GitHub Actions).
2. **Repository description** (Settings > General):
   `three.js MCP server and CLI for coding agents: version-pinned API and review, asset checks, headless runs, perf, 3D models`
   **Website:** `https://laaielichter.github.io/Threesmith/`
3. **Topics:** `threejs`, `three-js`, `webgl`, `webgpu`, `mcp`, `mcp-server`, `model-context-protocol`,
   `claude-code`, `claude-code-plugin`, `codex`, `cursor`, `ai-agents`, `coding-agent`, `react-three-fiber`, `gltf`,
   `linter`, `headless`, `github-action`, `gemini-cli-extension`, `agent-skills`.
4. **Social preview:** Settings > General > Social preview > upload `docs/og.png` (there is no API for it).
5. **Release 0.2.0:** move the Unreleased section of `CHANGELOG.md` under `## 0.2.0`, `npm version 0.2.0`, push the
   commit and the tag. The Publish workflow goes to npm and the MCP Registry, the Release workflow attaches the bundle.
6. **Listings, after npm:** Glama ("Add MCP Server", the `Dockerfile` is ready), then the awesome-mcp-servers PR
   with the Glama badge (the fork `laaielichter/awesome-mcp-servers` exists), mcp.so, the Claude plugin directory.
   Check each page's current rules first.

## Good first issues (drafts)

- **Rule: `Object3D.lookAt` on a camera before its position is set** (an easy text rule, with a firing and a quiet
  case in `test/rules.cases.ts`).
- **Explain pattern for "THREE.WebGLRenderer: A WebGL context could not be created"** with a real message captured in
  headless Chromium without GPU flags, and a case in `test/explain.test.ts`.
- **Gallery: render the 36 kinds that are not on the models page yet** (`node scripts/gallery.mjs <kind ...>`, then
  `scripts/models-page.py`), checking each render looks right.
- **`threesmith scan`: read `base` from `vite.config.*`** and show it on the `stack:` line.
- **A lesson from your own project:** a three.js bug that took more than one try, written as a bundled lesson that
  passes `test/lessons.test.ts`.

## Launch drafts

Post only after the npm release, from your own account, and answer every comment.

**Show HN** (human must rewrite; HN wants your own words): *Show HN: Threesmith – checks the three.js code coding
agents write.* Points to make in your words: agents write three.js from old releases and cannot see the canvas; it
reads the installed `node_modules/three`, opens the page headless and reads the live scene; the
`examples/agent-mistakes` before/after; a real limit (frame times are software rendering, a heuristic review); ask
what three.js mistakes they see agents make most.

**r/threejs** (check the current rules first): *I built an MCP server that checks three.js code written by AI agents
against the three version you have installed.* One paragraph on the before/after, the doctor output as a code
block, the link, and the question: which mistakes should it catch next?

**X / Bluesky:** the before/after image, one line ("Coding agents write three.js from 2020. Threesmith checks it
against your installed release, then opens the page headless."), the link.

## Measure

Weekly: stars, npm downloads, GitHub traffic (only 14 days are kept), issues opened by others. Note what each post
brought in the week after.
