import { existsSync } from "node:fs";
import { findThree } from "../api/install.js";
import { findChromium, loadPlaywright, WEBGL_ARGS } from "../check/browser.js";

export interface DoctorItem {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do when it is not ok. */
  fix?: string;
}

/** Is everything Threesmith needs here? Each item says what is wrong and what to do. */
export async function doctor(path: string, threeDir?: string): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  items.push({
    name: "node",
    ok: major >= 22,
    detail: `Node ${process.versions.node}`,
    ...(major >= 22 ? {} : { fix: "Install Node.js 22.12 or newer." }),
  });
  const three = findThree(path, threeDir);
  items.push(
    three
      ? { name: "three", ok: true, detail: `r${three.release} (${three.version}) at ${three.root}` }
      : { name: "three", ok: false, detail: `not found at or above ${path}`, fix: "Run `npm install three` in the project, or pass --three <path to node_modules/three>. api and review need it to be exact." },
  );
  if (three) {
    const addons = existsSync(`${three.root}/examples/jsm`);
    items.push({ name: "three addons", ok: addons, detail: addons ? "examples/jsm present" : "examples/jsm missing", ...(addons ? {} : { fix: "Reinstall three; the addons ship in the package." }) });
  }
  let pw: Awaited<ReturnType<typeof loadPlaywright>> | undefined;
  try {
    pw = await loadPlaywright();
    items.push({ name: "playwright-core", ok: true, detail: "found" });
  } catch (e) {
    items.push({ name: "playwright-core", ok: false, detail: (e as Error).message, fix: "npm i -D playwright-core (only the browser check needs it)." });
  }
  const chromium = findChromium();
  if (pw) {
    try {
      const browser = await pw.chromium.launch({ headless: true, ...(chromium ? { executablePath: chromium } : {}), args: WEBGL_ARGS });
      const page = await browser.newPage();
      const gl = (await page.evaluate(
        `(() => { const c = document.createElement("canvas"); return c.getContext("webgl2") ? "webgl2" : c.getContext("webgl") ? "webgl" : "none"; })()`,
      )) as string;
      await browser.close();
      items.push({ name: "chromium + WebGL", ok: gl !== "none", detail: `launches; ${gl}${chromium ? ` (${chromium})` : ""}`, ...(gl === "none" ? { fix: "Chromium started but has no WebGL. On Linux install mesa/libgl (apt install libgl1-mesa-dri)." } : {}) });
    } catch (e) {
      items.push({ name: "chromium + WebGL", ok: false, detail: String((e as Error).message).split("\n")[0] ?? "", fix: "npx playwright-core install --with-deps chromium, or set THREESMITH_CHROMIUM to a Chromium binary." });
    }
  }
  return items;
}

export function formatDoctor(items: DoctorItem[]): string {
  const out = items.map((i) => `${i.ok ? "✔" : "✖"} ${i.name}: ${i.detail}${i.fix ? `\n    fix: ${i.fix}` : ""}`);
  const bad = items.filter((i) => !i.ok).length;
  out.push("", bad ? `${bad} problem${bad === 1 ? "" : "s"} found.` : "All good.");
  return out.join("\n");
}
