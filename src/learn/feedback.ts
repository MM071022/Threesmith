import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gradeOf, score, type ReviewResult } from "../review/review.js";
import type { Finding } from "../review/types.js";

/**
 * Local learning from feedback: a finding the agent verified as a false alarm is hidden from later reviews on this
 * machine, and a rule that keeps being wrong here gets a note. Nothing but hashes and counters is stored: no code,
 * no names, no paths. $THREESMITH_HOME (default ~/.threesmith) holds the file; THREESMITH_LEARN=0 turns it off.
 */

export interface FeedbackStore {
  version: 1;
  /** Hashes of (rule + the finding's line text) marked wrong. */
  wrong: Record<string, { rule: string; at: string }>;
  /** Per rule: how often it was marked wrong and right. */
  rules: Record<string, { wrong: number; right: number }>;
}

export const threesmithHome = (): string => process.env["THREESMITH_HOME"] || join(homedir(), ".threesmith");
const storeFile = (): string => join(threesmithHome(), "feedback.json");
export const learningOn = (): boolean => !/^(0|false|no|off)$/i.test(process.env["THREESMITH_LEARN"]?.trim() ?? "");

const empty = (): FeedbackStore => ({ version: 1, wrong: {}, rules: {} });

export function readFeedback(): FeedbackStore {
  try {
    const s = JSON.parse(readFileSync(storeFile(), "utf8")) as FeedbackStore;
    if (s && s.version === 1 && typeof s.wrong === "object" && typeof s.rules === "object") return s;
  } catch {
    /* none yet */
  }
  return empty();
}

function writeFeedback(s: FeedbackStore): void {
  const file = storeFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, file);
}

/** The fingerprint of a finding: its rule and its line text with whitespace collapsed, hashed. Survives line moves. */
export function fingerprint(rule: string, snippet: string): string {
  return createHash("sha256").update(`${rule}\n${snippet.replace(/\s+/g, " ").trim()}`).digest("hex").slice(0, 24);
}

export type Verdict = "wrong" | "right";

export function recordFeedback(f: Pick<Finding, "rule" | "snippet">, verdict: Verdict): { rule: string; wrong: number; right: number } {
  const s = readFeedback();
  const counts = (s.rules[f.rule] ??= { wrong: 0, right: 0 });
  counts[verdict]++;
  const key = fingerprint(f.rule, f.snippet);
  if (verdict === "wrong") s.wrong[key] = { rule: f.rule, at: new Date().toISOString().slice(0, 10) };
  else delete s.wrong[key];
  writeFeedback(s);
  return { rule: f.rule, ...counts };
}

export interface Learned {
  /** Findings hidden because they were marked wrong. */
  hidden: number;
  /** Rules marked wrong at least 3 times and more often wrong than right. */
  doubtful: string[];
}

/** Remove the findings marked wrong on this machine. Learning off: the review as it is. */
export function applyFeedback(r: ReviewResult): { review: ReviewResult; learned: Learned } {
  if (!learningOn()) return { review: r, learned: { hidden: 0, doubtful: [] } };
  const s = readFeedback();
  const kept = r.findings.filter((f) => !s.wrong[fingerprint(f.rule, f.snippet)]);
  const hidden = r.findings.length - kept.length;
  const fired = new Set(kept.map((f) => f.rule));
  const doubtful = Object.entries(s.rules)
    .filter(([rule, c]) => fired.has(rule) && c.wrong >= 3 && c.wrong > c.right)
    .map(([rule]) => rule);
  if (!hidden) return { review: r, learned: { hidden, doubtful } };
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of kept) counts[f.severity]++;
  const sc = r.score === null ? undefined : score(kept);
  const review: ReviewResult = { ...r, findings: kept, counts, ...(sc ? { score: sc.total, grade: gradeOf(sc.total), categories: sc.categories } : {}) };
  return { review, learned: { hidden, doubtful } };
}

export function formatLearned(l: Learned): string {
  const out: string[] = [];
  if (l.hidden) out.push(`${l.hidden} finding(s) hidden: marked as false alarms on this machine (three_feedback verdict right brings one back).`);
  for (const rule of l.doubtful) out.push(`rule ${rule} was marked wrong often here; check it, and skip it with disable: ["${rule}"] if it does not fit this project.`);
  return out.join("\n");
}
