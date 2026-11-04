// Fills the terminal blocks of docs/index.html with real output of the CLI on examples/agent-mistakes.
// node scripts/site.mjs   (needs `npm run build`; the check needs Chromium)
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const example = join(repo, "examples", "agent-mistakes");
const cli = join(repo, "dist", "cli.js");

function run(args) {
  try {
    return execFileSync("node", [cli, ...args], { cwd: example, encoding: "utf8", timeout: 180_000 });
  } catch (e) {
    // the commands exit 1 when they find problems; the output is what we want
    return String(e.stdout ?? "");
  }
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function colour(text) {
  return text
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => {
      const l = esc(line);
      if (/^\s*(✖|\d+\. ✖)/.test(line) || /: FAIL/.test(line)) return `<span class="e">${l}</span>`;
      if (/^\s*(▲|\d+\. ▲)/.test(line)) return `<span class="w">${l}</span>`;
      if (/PASS|^review 100/.test(line)) return `<span class="ok">${l}</span>`;
      if (/^(Threesmith|Next:|Would fix|review )/.test(line)) return `<span class="h">${l}</span>`;
      if (/^\s+(why|fix):/.test(line)) return `<span class="m">${l}</span>`;
      return l;
    })
    .join("\n");
}

const clean = (s) => s.split(repo).join(".").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:5173");
const out = {
  doctor: run(["doctor", "--no-env"]),
  fix: run(["fix", "."]),
  check: run(["check", ".", "--root", "../..", "--wait", "1500"]),
};
rmSync(join(example, ".threesmith"), { recursive: true, force: true });

const file = join(repo, "docs", "index.html");
let html = readFileSync(file, "utf8");
for (const [name, text] of Object.entries(out)) {
  const re = new RegExp(`<!--out:${name}-->[\\s\\S]*?<!--/out-->`);
  if (!re.test(html)) throw new Error(`no <!--out:${name}--> block in docs/index.html`);
  html = html.replace(re, () => `<!--out:${name}-->${colour(clean(text))}<!--/out-->`);
}
writeFileSync(file, html);
console.log(Object.entries(out).map(([k, v]) => `${k}: ${v.split("\n").length} lines`).join(", "));
