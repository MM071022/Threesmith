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

/** Chrome and Edge where they install by default, used when no Playwright Chromium is there (Edge comes with Windows). */
export function systemBrowsers(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] {
  if (platform === "win32") {
    const bases = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter((x): x is string => !!x);
    return bases.flatMap((b) => [join(b, "Google", "Chrome", "Application", "chrome.exe"), join(b, "Microsoft", "Edge", "Application", "msedge.exe")]);
  }
  if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  return ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/microsoft-edge"];
}

/** Where Playwright keeps its browsers by default, per platform. */
function playwrightRoots(env: NodeJS.ProcessEnv): string[] {
  const home = env["HOME"] ?? env["USERPROFILE"] ?? "";
  return [env["PLAYWRIGHT_BROWSERS_PATH"], "/opt/pw-browsers", env["LOCALAPPDATA"] ? join(env["LOCALAPPDATA"], "ms-playwright") : undefined, home ? join(home, ".cache", "ms-playwright") : undefined, home ? join(home, "Library", "Caches", "ms-playwright") : undefined].filter(
    (x): x is string => !!x && x !== "0",
  );
}

export function findChromium(): string | undefined {
  const env = process.env["THREESMITH_CHROMIUM"] ?? process.env["CHROMIUM_PATH"];
  if (env && existsSync(env)) return env;
  const found = findPlaywrightChromium();
  if (found) return found;
  return systemBrowsers().find((p) => existsSync(p));
}

function findPlaywrightChromium(): string | undefined {
  const roots = playwrightRoots(process.env);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => d.startsWith("chromium") && !d.includes("headless_shell")).sort().reverse();
    for (const d of dirs) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"]) {
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
