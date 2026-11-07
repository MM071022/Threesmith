import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { findChromium, WEBGL_ARGS } from "../src/check/browser.js";
import { serveStatic, type StaticServer } from "../src/check/server.js";

const executablePath = findChromium();
// Self-hosted assets only: these tests do not depend on fonts, CDNs or third-party services.
describe.skipIf(!executablePath)("project website in Chromium", () => {
  let browser: Browser;
  let server: StaticServer;
  beforeAll(async () => {
    server = await serveStatic(resolve("docs"));
    browser = await chromium.launch({ executablePath, args: WEBGL_ARGS });
  });
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it("renders the actual model, honors reduced motion and changes the rendered view", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    try {
      await context.route("https://**", route => route.abort());
      const page = await context.newPage();
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(server.url);
      await page.waitForFunction("document.getElementById('model-stage').dataset.state === 'ready'");
      const rotation = page.getByRole("button", { name: "Rotate model", exact: true });
      expect(await rotation.getAttribute("aria-pressed")).toBe("false");
      const canvas = page.locator("#model-stage canvas");
      const solid = await canvas.screenshot();
      const wireframe = page.getByRole("button", { name: "Wireframe", exact: true });
      await wireframe.click();
      expect(await wireframe.getAttribute("aria-pressed")).toBe("true");
      expect((await canvas.screenshot()).equals(solid)).toBe(false);
      await wireframe.click();
      await page.getByRole("button", { name: "Rotate model left", exact: true }).focus();
      await page.keyboard.press("Enter");
      expect((await canvas.screenshot()).equals(solid)).toBe(false);
      await page.getByRole("button", { name: "Reset view", exact: true }).click();
      await rotation.click();
      expect(await page.getByRole("button", { name: "Pause rotation" }).getAttribute("aria-pressed")).toBe("true");
      await page.getByRole("button", { name: "Pause rotation" }).click();
      await canvas.dispatchEvent("webglcontextlost");
      expect(await page.locator("#model-stage").getAttribute("data-state")).toBe("fallback");
      expect(await page.locator("#model-fallback").isVisible()).toBe(true);
      expect(await wireframe.isDisabled()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it("supports installation by keyboard, correct clipboard contents, comparison and gallery filters", async () => {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], reducedMotion: "reduce" });
    try {
      await context.route("https://**", route => route.abort());
      const page = await context.newPage(); await page.goto(server.url);
      await page.getByRole("tab", { name: "CLI", exact: true }).focus(); await page.keyboard.press("ArrowRight");
      expect(await page.getByRole("tab", { name: "Codex", exact: true }).getAttribute("aria-selected")).toBe("true");
      await page.locator("#setup-panel [data-copy]").click();
      expect(await page.evaluate("navigator.clipboard.readText()")).toBe("codex mcp add threesmith -- npx -y threesmith mcp --tier premium");
      await page.getByRole("tab", { name: "Other MCP", exact: true }).click();
      const config = JSON.parse((await page.locator("#setup-command").textContent())!);
      expect(config.mcpServers.threesmith.args).toEqual(["-y", "threesmith", "mcp"]);
      await page.getByRole("button", { name: "Vehicles", exact: true }).click();
      expect(await page.locator(".model-card:visible").count()).toBe(2);
      await page.getByRole("button", { name: "Everything", exact: true }).click();
      expect(await page.locator(".model-card:visible").count()).toBe(6);
      const slider = page.getByRole("slider", { name: "Compare the scene" }); await slider.focus(); await slider.press("End");
      expect(await slider.getAttribute("aria-valuetext")).toBe("100% original scene, 0% fixed scene");
      const original = await page.locator(".image-compare").screenshot(); await slider.press("Home");
      expect(await slider.getAttribute("aria-valuetext")).toBe("0% original scene, 100% fixed scene");
      expect((await page.locator(".image-compare").screenshot()).equals(original)).toBe(false);
    } finally { await context.close(); }
  });

  it("keeps the poster and disables controls when WebGL is unavailable", async () => {
    const context = await browser.newContext();
    try {
      await context.route("https://**", route => route.abort());
      await context.addInitScript("const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(type, ...args) { return /webgl/.test(type) ? null : original.call(this, type, ...args); };");
      const page = await context.newPage(); await page.goto(server.url);
      await page.waitForFunction("document.getElementById('model-stage').dataset.state === 'fallback'");
      expect(await page.locator("#model-fallback").isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Wireframe", exact: true }).isDisabled()).toBe(true);
      expect(await page.locator("#viewer-status").textContent()).toContain("Static preview");
    } finally { await context.close(); }
  });

  it("keeps the gallery, preview and installation readable without JavaScript", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      await context.route("https://**", route => route.abort());
      const page = await context.newPage(); await page.goto(server.url);
      expect(await page.locator("#model-fallback").isVisible()).toBe(true);
      expect(await page.locator(".model-card").count()).toBe(6);
      expect(await page.locator("#setup-command").textContent()).toBe("npx -y threesmith doctor");
      expect(await page.locator(".viewer-toolbar").isVisible()).toBe(false);
      expect(await page.locator("#install a[href='install.html']").isVisible()).toBe(true);
    } finally { await context.close(); }
  });
});
