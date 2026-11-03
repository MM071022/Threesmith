import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatSearch, lookup, search } from "../api/lookup.js";
import { check, formatCheck } from "../check/check.js";
import { indexFor } from "../core.js";
import { formatMarkdown } from "../review/format.js";
import { review } from "../review/review.js";
import { VERSION } from "../version.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const fail = (e: unknown) => text((e as Error).message, true);

export function createServer(): McpServer {
  const server = new McpServer({ name: "threesmith", version: VERSION });
  const common = {
    path: z.string().optional().describe("Project directory (default: current directory). Used to find node_modules/three."),
    three: z.string().optional().describe("Path to a three package directory, when it is not in node_modules above `path`."),
  };

  server.registerTool(
    "three_api",
    {
      title: "three.js API lookup",
      description:
        "Exact API of a three.js class, constant or member, read from the three version installed in the project (not from memory). Use before writing or changing three.js code. Query: `Mesh`, `WebGLRenderer.setPixelRatio`, `OrbitControls`. Also tells where to import it from and what is deprecated.",
      inputSchema: { query: z.string(), inherited: z.boolean().optional(), full: z.boolean().optional(), ...common },
      annotations: { readOnlyHint: true },
    },
    ({ query, inherited, full, path, three }) => {
      try {
        const r = lookup(indexFor(path ?? process.cwd(), three), query, { ...(inherited ? { inherited } : {}), ...(full ? { full } : {}) });
        return text(r.text, !r.found);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "three_search",
    {
      title: "Search the three.js API",
      description: "Find three.js classes, constants or members by (part of a) name in the installed version. Set members to also search method and property names.",
      inputSchema: { query: z.string(), members: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional(), ...common },
      annotations: { readOnlyHint: true },
    },
    ({ query, members, limit, path, three }) => {
      try {
        const index = indexFor(path ?? process.cwd(), three);
        return text(formatSearch(index, search(index, query, { ...(members ? { members } : {}), ...(limit ? { limit } : {}) })));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "three_review",
    {
      title: "Review three.js code",
      description:
        "Scored review (0-100) of the three.js code in a directory or file: outdated or removed APIs for the installed version, symbols that do not exist, code that renders nothing (no lights, shadows off, renderer not attached), per-frame allocations, missing resize and dispose handling, color management. Run it after changing three.js code and fix the errors first.",
      inputSchema: { target: z.string().optional().describe("Directory or file to review (default: current directory)."), limit: z.number().int().min(1).max(200).optional(), disable: z.array(z.string()).optional(), three: common.three },
      annotations: { readOnlyHint: true },
    },
    ({ target, limit, disable, three }) => {
      try {
        const r = review({ path: target ?? process.cwd(), ...(three ? { three } : {}), ...(disable ? { disable } : {}) });
        return { content: [{ type: "text" as const, text: formatMarkdown(r, { limit: limit ?? 40 }) }, { type: "text" as const, text: JSON.stringify({ score: r.score, grade: r.grade, counts: r.counts, findings: r.findings.slice(0, limit ?? 40) }) }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "three_check",
    {
      title: "Run a three.js page headless",
      description:
        "Open a page in headless Chromium (software WebGL 2): reports console errors, failed requests, missing canvas/WebGL context, lost context, blank frames and the three revision, and returns a screenshot. Optionally compares against a named baseline screenshot. Target is a folder with index.html or an http URL of a dev server. WebGPU is best effort.",
      inputSchema: {
        target: z.string().describe("Folder with the page, or http(s) URL."),
        entry: z.string().optional(),
        root: z.string().optional().describe("Folder to serve when the page needs files above its own folder (for example ../node_modules)."),
        wait: z.number().int().min(0).max(30000).optional().describe("Milliseconds to let the scene run (default 2000)."),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        baseline: z.string().optional().describe("Baseline name; created on first run."),
        update_baseline: z.boolean().optional(),
        tolerance: z.number().min(0).max(1).optional(),
        webgpu: z.boolean().optional(),
        ignore: z.array(z.string()).optional(),
      },
    },
    async (a) => {
      try {
        const r = await check({
          target: a.target,
          ...(a.entry ? { entry: a.entry } : {}),
          ...(a.root ? { root: a.root } : {}),
          ...(a.wait !== undefined ? { wait: a.wait } : {}),
          ...(a.width ? { width: a.width } : {}),
          ...(a.height ? { height: a.height } : {}),
          ...(a.baseline ? { baseline: a.baseline } : {}),
          ...(a.update_baseline ? { updateBaseline: true } : {}),
          ...(a.tolerance !== undefined ? { tolerance: a.tolerance } : {}),
          ...(a.webgpu ? { webgpu: true } : {}),
          ...(a.ignore ? { ignore: a.ignore } : {}),
        });
        const content: Content[] = [{ type: "text", text: formatCheck(r) }];
        if (r.screenshot) content.push({ type: "image", data: readFileSync(r.screenshot).toString("base64"), mimeType: "image/png" });
        return { content, ...(r.ok ? {} : { isError: true }) };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "three_version",
    {
      title: "Installed three.js version",
      description: "Which three.js version the project has installed (release number such as r187).",
      inputSchema: common,
      annotations: { readOnlyHint: true },
    },
    ({ path, three }) => {
      try {
        const i = indexFor(path ?? process.cwd(), three).install;
        return text(`three r${i.release} (${i.version}) at ${i.root}`);
      } catch (e) {
        return fail(e);
      }
    },
  );
  return server;
}

export async function serveStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
