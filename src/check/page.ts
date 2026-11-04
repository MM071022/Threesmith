import { join, relative, resolve, sep } from "node:path";
import type { Browser, CDPSession, Page } from "playwright-core";
import { findChromium, loadPlaywright, WEBGL_ARGS, WEBGPU_ARGS } from "./browser.js";
import { serveStatic, type StaticServer } from "./server.js";
import { indexFor } from "../core.js";
import type { ApiIndex } from "../api/index-builder.js";
import { explain, parseShaderErrors } from "../explain/explain.js";
import { locateCode } from "../explain/locate.js";
import type { Issue } from "./check.js";

/** How to open a page: the options check, play, perf and leaks share. */
export interface PageOptions {
  /** Folder with the page, or an http(s) URL of a running dev server. */
  target: string;
  /** HTML file inside the folder. Default index.html. */
  entry?: string;
  /** Folder the static server serves, when the page needs files above its own folder (for example ../node_modules). Default: the target folder. */
  root?: string;
  width?: number;
  height?: number;
  /** Also try WebGPU (best effort). */
  webgpu?: boolean;
  /** Where screenshots and run state live. Default <folder>/.threesmith. */
  stateDir?: string;
  /** Console warnings and failed requests that are not a problem. Substring match. */
  ignore?: string[];
}

export interface OpenedPage {
  page: Page;
  browser: Browser;
  url: string;
  isUrl: boolean;
  /** The page's folder (the working directory for a URL). */
  folder: string;
  serveRoot: string;
  stateDir: string;
  /** Errors and warnings the page raised so far; keeps filling while the page runs. */
  issues: Issue[];
  /** False when the page could not be opened (a load-failed issue says why). */
  loaded: boolean;
  /** A Chrome DevTools Protocol session on the page (garbage collection, heap size). */
  cdp(): Promise<CDPSession>;
  close(): Promise<void>;
}

/**
 * Launches headless Chromium with software WebGL, serves the folder, installs the init scripts, collects console,
 * page and request errors (with explanations and shader lines mapped to the project), and opens the page.
 */
export async function openPage(opts: PageOptions & { init?: string[] }): Promise<OpenedPage> {
  const pw = await loadPlaywright();
  const isUrl = /^https?:\/\//.test(opts.target);
  const folder = isUrl ? process.cwd() : resolve(opts.target);
  const serveRoot = opts.root ? resolve(opts.root) : folder;
  let server: StaticServer | undefined;
  const entryPath = relative(serveRoot, join(folder, opts.entry ?? "index.html")).split(sep).join("/");
  const issues: Issue[] = [];
  const ignore = opts.ignore ?? [];
  const skip = (text: string) => ignore.some((i) => text.includes(i));
  const executablePath = findChromium();
  const browser = await pw.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [...WEBGL_ARGS, ...(opts.webgpu ? WEBGPU_ARGS : [])],
  });
  try {
    server = isUrl ? undefined : await serveStatic(serveRoot);
  } catch (e) {
    await browser.close();
    throw e;
  }
  const url = isUrl ? opts.target : `${server?.url}/${entryPath}`;
  const page = await browser.newPage({ viewport: { width: opts.width ?? 800, height: opts.height ?? 600 }, deviceScaleFactor: 1 });
  for (const script of opts.init ?? []) await page.addInitScript(script);
  let index: ApiIndex | undefined;
  try {
    index = isUrl ? undefined : indexFor(folder);
  } catch {
    index = undefined; // three not installed next to the page: explanations without exact names
  }
  const annotate = (issue: Issue, text: string): Issue => {
    const ex = explain(text, index);
    if (ex.length) issue.explanations = ex;
    if (text.includes("\n")) issue.detail = text.slice(0, 4000);
    if (ex.some((e) => e.id === "shader-error")) {
      issue.shader = parseShaderErrors(text).map((e) => {
        const source = !isUrl && e.code ? locateCode(serveRoot, e.code) : undefined;
        return { ...e, ...(source ? { source } : {}) };
      });
    }
    return issue;
  };
  page.on("pageerror", (e) => {
    const text = String(e.message ?? e);
    issues.push(annotate({ kind: "page-error", severity: "error", message: text.split("\n")[0] ?? "" }, text));
  });
  page.on("console", (m) => {
    const text = m.text();
    if (skip(text)) return;
    if (m.type() === "error") {
      // failed resource loads are reported by requestfailed/response with the URL
      if (/Failed to load resource/.test(text)) return;
      issues.push(annotate({ kind: "console-error", severity: "error", message: text.split("\n")[0] ?? "" }, text));
    } else if (m.type() === "warning" && /THREE\./.test(text)) {
      issues.push(annotate({ kind: "console-warn", severity: "warn", message: text.split("\n")[0] ?? "" }, text));
    }
  });
  page.on("requestfailed", (r) => {
    if (!skip(r.url())) issues.push({ kind: "request-failed", severity: "error", message: `${r.url()} (${r.failure()?.errorText ?? "failed"})` });
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !skip(r.url())) issues.push({ kind: "request-failed", severity: "error", message: `${r.url()} -> HTTP ${r.status()}` });
  });
  let session: CDPSession | undefined;
  const opened: OpenedPage = {
    page,
    browser,
    url,
    isUrl,
    folder,
    serveRoot,
    stateDir: resolve(opts.stateDir ?? join(folder, ".threesmith")),
    issues,
    loaded: false,
    cdp: async () => (session ??= await page.context().newCDPSession(page)),
    close: async () => {
      await browser.close();
      await server?.close();
    },
  };
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    opened.loaded = true;
  } catch (e) {
    issues.push({ kind: "load-failed", severity: "error", message: `Could not open ${url}: ${(e as Error).message.split("\n")[0]}` });
  }
  return opened;
}
