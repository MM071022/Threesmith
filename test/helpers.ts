import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { review, type ReviewResult } from "../src/review/review.js";

export const THREE_DIR = resolve("node_modules/three");

export function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "threesmith-"));
  for (const [name, text] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
}

export function reviewFiles(files: Record<string, string>, opts: { pinned?: boolean; disable?: string[] } = {}): ReviewResult {
  return review({ path: project(files), ...(opts.pinned === false ? {} : { three: THREE_DIR }), ...(opts.disable ? { disable: opts.disable } : {}) });
}

export const ids = (r: ReviewResult): string[] => r.findings.map((f) => f.rule);
