# Installing Threesmith (for AI agents such as Cline)

Threesmith is an MCP server for three.js projects. It runs locally over stdio with `npx`; there is nothing to clone or
build, and it needs no API key.

## Requirements

- Node.js 22.12 or newer (`node --version`).
- A three.js project with `three` installed (`node_modules/three`). The API lookup and the review read it.
- Optional, for `three_check` (headless render): `npm i -D playwright-core` and a Chromium
  (`npx playwright-core install chromium`, or set `THREESMITH_CHROMIUM` to a Chromium binary).
  Run `npx threesmith doctor` in the project to see what is missing.

## Add the server

Add this entry to the MCP settings (for Cline: `cline_mcp_settings.json`, under `mcpServers`):

```json
{
  "mcpServers": {
    "threesmith": {
      "command": "npx",
      "args": ["-y", "threesmith", "mcp", "--project", "/absolute/path/to/the/threejs/project"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

- Replace the path with the folder that holds `package.json` and `node_modules/three`. Without `--project`, the server
  uses the working directory.
- The first start downloads the package from npm, which can take up to 30 seconds.

## Check that it works

Call `three_version` (which three release is installed), then `three_api` with `Mesh`, then `three_review` on the
project. None of them needs a browser.

Start with `three_doctor` in a project you do not know: it says what is wrong and in which order to fix it.

## Options

- `--tier cheap` (default): short output and step-by-step instructions. `--tier premium`: full detail for large models.
- `--tools core,run`: load only some tool sets (`core`, `run`, `live`, `build`, `model`, `all`) or single tools.
- `--read-only`: leave out the tools that always write and refuse write options (dry runs still work).
- Environment: `THREESMITH_PROJECT`, `THREESMITH_TIER`, `THREESMITH_TOOLS`, `THREESMITH_READ_ONLY=1`,
  `THREESMITH_PROTECT` (folders no write may touch), `THREESMITH_LEARN=0` (no local learning).
- CLI output is plain ASCII on Windows when it is piped (PowerShell would garble UTF-8 symbols); `THREESMITH_ASCII=1`
  forces that everywhere, `THREESMITH_ASCII=0` keeps the symbols.

## What it writes and sends

Most tools only read the project. Writes: `three_fix` with `write: true`, `three_model_build`, `three_scenario` op save
(each undoable with `three_undo`), and local state in `.threesmith/` (screenshots, baselines, perf history, the undo
journal, review memory; the local part is git-ignored). `three_build` runs the project's own build script. Lessons and
false-alarm feedback live in `~/.threesmith` (or `$THREESMITH_HOME`), scrubbed of names, paths and code. Nothing is
sent anywhere: there is no telemetry. See [PRIVACY.md](PRIVACY.md).
