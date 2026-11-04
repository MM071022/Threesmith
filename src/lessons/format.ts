import type { LessonHit } from "./search.js";

/** Lessons as compact text for agents: one lesson in at most 6 short lines, a list as id, title and fix. */

type Shown = Pick<LessonHit, "lesson" | "local" | "helped" | "wrong">;

function head(hit: Shown): string {
  const learned = hit.helped || hit.wrong ? ` (helped ${hit.helped}, wrong ${hit.wrong})` : "";
  return `${hit.lesson.id}${hit.local ? " [learned here]" : ""}: ${hit.lesson.title}${learned}`;
}

/** The whole lesson: title, symptom, cause, fix, then the test and what checks or prints it. */
export function formatLesson(hit: Shown): string {
  const l = hit.lesson;
  const out = [head(hit), `  symptom: ${l.symptom}`, `  cause: ${l.cause}`, `  fix: ${l.fix}`];
  if (l.test) out.push(`  test: ${l.test}`);
  const seen = [
    l.rules?.length ? `review rules: ${l.rules.join(", ")}` : "",
    l.errors?.length ? `messages: ${l.errors.map((e) => `"${e}"`).join(", ")}` : "",
  ].filter(Boolean);
  if (seen.length) out.push(`  ${seen.join("; ")}`);
  return out.join("\n");
}

/** A list: each lesson as its id and title, and its fix on the next line. */
export function formatLessonList(hits: Shown[], query = ""): string {
  if (!hits.length) return `no lessons${query ? ` for "${query}"` : ""}. three_lesson_add keeps one you learned.\n`;
  const out = hits.map((h) => `${head(h)}\n  fix: ${h.lesson.fix}`);
  out.push("", "three_lessons id=<id> shows one in full; id=<id> verdict=helped (or wrong) records whether it fit, which ranks them.");
  return `${out.join("\n")}\n`;
}

/** One line under check, review or explain output that points to a lesson. */
export function hintLine(hit: Shown): string {
  return `lesson ${hit.lesson.id}: ${hit.lesson.title} (three_lessons id=${hit.lesson.id})`;
}
