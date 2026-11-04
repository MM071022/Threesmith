// Renders scripts/og.html to docs/og.png (1280x640, the GitHub social preview and the site's og:image).
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { findChromium } from "../dist/check/browser.js";

const repo = resolve(import.meta.dirname, "..");
const executablePath = findChromium();
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(repo, "scripts", "og.html")).href, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(repo, "docs", "og.png") });
await browser.close();
console.log("docs/og.png");
