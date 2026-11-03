import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Chromium flags that give a working software WebGL 2 in a headless CI runner. */
export const WEBGL_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--enable-webgl",
  "--no-sandbox",
];

/** WebGPU in headless Chromium is best effort: it needs these flags and a Vulkan/software adapter. */
export const WEBGPU_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--use-webgpu-adapter=swiftshader"];

export function findChromium(): string | undefined {
  const env = process.env["THREESMITH_CHROMIUM"] ?? process.env["CHROMIUM_PATH"];
  if (env && existsSync(env)) return env;
  const roots = [process.env["PLAYWRIGHT_BROWSERS_PATH"], "/opt/pw-browsers"].filter((x): x is string => !!x);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => d.startsWith("chromium") && !d.includes("headless_shell")).sort().reverse();
    for (const d of dirs) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"]) {
        const p = join(root, d, rel);
        if (existsSync(p)) return p;
      }
      if (d === "chromium" && existsSync(join(root, d, "chrome"))) return join(root, d, "chrome");
    }
  }
  return undefined;
}

export async function loadPlaywright(): Promise<typeof import("playwright-core")> {
  for (const name of ["playwright-core", "playwright"]) {
    try {
      return (await import(name)) as typeof import("playwright-core");
    } catch {
      /* try next */
    }
  }
  throw new Error("The browser check needs playwright-core. Install it: npm i -D playwright-core && npx playwright install chromium");
}
