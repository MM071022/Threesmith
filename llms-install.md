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

## What it writes and sends

The tools only read the project. `three_check` writes screenshots and baselines to `.threesmith/` in the folder it
checks. It sends nothing: there is no telemetry. See [PRIVACY.md](PRIVACY.md).
