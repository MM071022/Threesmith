import { withoutPlaceholders } from "./anonymize.js";
import { bundledLessons } from "./library.js";
import type { Lesson, LessonStats, LessonTopic, LocalData } from "./types.js";

/**
 * Finding the lessons that fit: by words, by a console or build message, by a review rule, or by id. Feedback kept
 * on this machine ranks them: a lesson that helped comes first, one marked wrong more often than it helped is no
 * longer offered unasked.
 */

export interface LessonHit {
  lesson: Lesson;
  score: number;
  /** Learned on this machine. */
  local: boolean;
  helped: number;
  wrong: number;
}

/** A lesson marked wrong this often, and more often than it helped, is no longer offered unasked. */
export const QUIET_AFTER_WRONG = 3;

export interface SearchOptions {
  topic?: LessonTopic;
  limit?: number;
  /** Local lessons and feedback; read from the local file by the callers that have it. */
  local?: LocalData;
}

/** All lessons: the bundled ones, then those learned on this machine. */
export function allLessons(local?: LocalData): { lesson: Lesson; local: boolean }[] {
  return [...bundledLessons().map((lesson) => ({ lesson, local: false })), ...(local?.lessons ?? []).map((lesson) => ({ lesson, local: true }))];
}

function statsOf(id: string, local?: LocalData): LessonStats {
  const s = local?.stats[id];
  return { helped: s?.helped ?? 0, wrong: s?.wrong ?? 0 };
}

export function quiet(hit: Pick<LessonHit, "helped" | "wrong">): boolean {
  return hit.wrong >= QUIET_AFTER_WRONG && hit.wrong > hit.helped;
}

/** How much feedback moves a lesson up or down. */
function weight({ helped, wrong }: LessonStats): number {
  return (1 + Math.log2(1 + helped) * 0.5) / (1 + Math.log2(1 + wrong) * 0.5);
}

const STOP = new Set(["the", "and", "for", "with", "not", "does", "how", "why", "what", "when", "this", "that", "from", "into", "are", "but", "can", "get", "has", "have", "you", "your", "its", "use", "after"]);

/** A rough singular form, applied to both sides of a comparison. */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(ches|shes|xes|zes|ses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map(stem);
}

function sorted(hits: LessonHit[], limit: number): LessonHit[] {
  return hits.sort((a, b) => b.score - a.score || a.lesson.id.localeCompare(b.lesson.id)).slice(0, limit);
}

/** Lessons for a question in words, best first. Empty text lists them all (by topic, if given). */
export function searchLessons(query: string, options: SearchOptions = {}): LessonHit[] {
  const q = [...new Set(words(query))];
  const hits: LessonHit[] = [];
  for (const { lesson, local } of allLessons(options.local)) {
    if (options.topic && lesson.topic !== options.topic) continue;
    let score = q.length ? 0 : 1;
    if (q.length) {
      const tags = new Set(lesson.tags.flatMap(words));
      const title = new Set(words(lesson.title));
      const id = new Set(words(lesson.id));
      const body = new Set(words(`${lesson.symptom} ${lesson.cause} ${lesson.fix} ${lesson.test ?? ""} ${(lesson.errors ?? []).join(" ")} ${(lesson.rules ?? []).join(" ")}`));
      let matched = 0;
      for (const w of q) {
        const s = (tags.has(w) ? 3 : 0) + (title.has(w) ? 2 : 0) + (id.has(w) ? 2 : 0) + (body.has(w) ? 1 : 0);
        if (s) matched++;
        score += s;
      }
      if (!matched) continue;
      // A lesson that matches more of the question's words wins over one that matches a single word often.
      score *= (matched / q.length) ** 2;
    }
    const stats = statsOf(lesson.id, options.local);
    hits.push({ lesson, local, score: score * weight(stats), ...stats });
  }
  return sorted(hits, options.limit ?? (q.length ? 5 : 200));
}

/** A message fragment as a matcher: plain text matches as a substring; `<kind>` placeholders match any text. */
function fragmentMatcher(fragment: string): RegExp {
  const parts = fragment.split(/<\w+>/).map((p) => p.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return new RegExp(parts.filter(Boolean).join("[\\s\\S]*?"), "i");
}

/** How long the matched fragment is: a long, specific fragment beats a short one. */
function matchLength(message: string, errors: string[]): number {
  let best = 0;
  for (const e of errors) {
    if (!withoutPlaceholders(e).trim()) continue;
    const m = fragmentMatcher(e).exec(message);
    if (m) best = Math.max(best, withoutPlaceholders(e).length);
  }
  return best;
}

/** Lessons whose messages match this console or build message, most specific first. */
export function lessonsForError(message: string, options: Omit<SearchOptions, "topic"> = {}): LessonHit[] {
  const hits: LessonHit[] = [];
  for (const { lesson, local } of allLessons(options.local)) {
    const length = matchLength(message, lesson.errors ?? []);
    if (!length) continue;
    const stats = statsOf(lesson.id, options.local);
    const hit = { lesson, local, score: (1 + Math.log2(length)) * weight(stats) * (local ? 1.25 : 1), ...stats };
    if (!quiet(hit)) hits.push(hit);
  }
  return sorted(hits, options.limit ?? 3);
}

/** Lessons that explain a review rule. */
export function lessonsForRule(rule: string, options: Omit<SearchOptions, "topic"> = {}): LessonHit[] {
  const hits: LessonHit[] = [];
  for (const { lesson, local } of allLessons(options.local)) {
    if (!lesson.rules?.includes(rule)) continue;
    const stats = statsOf(lesson.id, options.local);
    // A lesson about only this rule explains it better than one that lists several.
    const hit = { lesson, local, score: weight(stats) / lesson.rules.length, ...stats };
    if (!quiet(hit)) hits.push(hit);
  }
  return sorted(hits, options.limit ?? 3);
}

/** A lesson by id, bundled or local. */
export function findLesson(id: string, local?: LocalData): LessonHit | undefined {
  const found = allLessons(local).find((l) => l.lesson.id === id.trim());
  return found && { ...found, score: 1, ...statsOf(found.lesson.id, local) };
}
