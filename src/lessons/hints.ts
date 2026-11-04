import { hintLine } from "./format.js";
import { readLocal } from "./local.js";
import { lessonsForError, lessonsForRule, type LessonHit } from "./search.js";

/** At most this many lesson lines go under one output. */
export const MAX_HINTS = 3;

function lines(hits: LessonHit[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (seen.has(h.lesson.id)) continue;
    seen.add(h.lesson.id);
    out.push(hintLine(h));
    if (out.length >= MAX_HINTS) break;
  }
  return out;
}

/** Lessons that explain console or build messages, as one-liners for check or explain output. Never throws. */
export function lessonHintsForMessages(messages: string[]): string[] {
  try {
    const local = readLocal();
    // The best lesson of each message first, then the runners-up.
    const per = [...new Set(messages)].slice(0, 50).map((m) => lessonsForError(m, { local, limit: 2 }));
    return lines([...per.map((h) => h[0]), ...per.flatMap((h) => h.slice(1))].filter((h): h is LessonHit => Boolean(h)));
  } catch {
    // Lessons are a help, never a reason for a tool to fail.
    return [];
  }
}

/** Lessons behind the rules of review findings, as one-liners. Never throws. */
export function lessonHintsForRules(ruleIds: string[]): string[] {
  try {
    const local = readLocal();
    return lines([...new Set(ruleIds)].flatMap((r) => lessonsForRule(r, { local, limit: 1 })));
  } catch {
    return [];
  }
}
