#!/usr/bin/env node
// Grade an agent's output for one benchmark task, without any model in the loop.
//   node bench/grade.mjs <task-id> <output-dir> [--three <path>] [--root <dir>]
// Exit code 0 = pass. Prints one JSON line.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ci } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function grade(taskId, dir, opts = {}) {
  const tasks = JSON.parse(readFileSync(join(here, "tasks", "tasks.json"), "utf8"));
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  const r = await ci({
    path: dir,
    failOn: "none",
    ...(opts.three ? { three: opts.three } : {}),
    ...(task.grade.check ? { check: { target: dir, wait: 1500, ...(opts.root ? { root: opts.root } : {}) } } : {}),
  });
  const fired = new Set(r.review.findings.map((f) => f.rule));
  const forbidden = task.grade.mustNotFire.filter((id) => fired.has(id));
  const reasons = [];
  if (r.review.score === null) reasons.push("no three.js code found");
  else if (r.review.score < task.grade.minScore) reasons.push(`score ${r.review.score} < ${task.grade.minScore}`);
  if (forbidden.length) reasons.push(`fired: ${forbidden.join(", ")}`);
  if (r.check && !r.check.ok) reasons.push(`check failed: ${r.check.issues.map((i) => i.kind).join(", ")}`);
  if (task.grade.check && !r.check) reasons.push("browser check did not run");
  return { task: taskId, pass: reasons.length === 0, score: r.review.score, errors: r.review.counts.error, reasons };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [taskId, dir, ...rest] = process.argv.slice(2);
  if (!taskId || !dir) {
    console.error("usage: node bench/grade.mjs <task-id> <output-dir> [--three <path>] [--root <dir>]");
    process.exit(2);
  }
  const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  const result = await grade(taskId, dir, { three: opt("--three"), root: opt("--root") });
  console.log(JSON.stringify(result));
  process.exit(result.pass ? 0 : 1);
}
