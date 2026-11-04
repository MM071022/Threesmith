import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isKnownName, placeholderShare, scrubText, type ScrubContext } from "./anonymize.js";
import { isTopic, LESSON_ID, lessonFrom } from "./library.js";
import { findLesson } from "./search.js";
import type { LessonStats, LessonTopic, LocalData, LocalLesson } from "./types.js";

/**
 * Lessons learned on this machine. An agent or a person writes down what it learned (symptom, cause, fix, the
 * message the browser printed), and Threesmith keeps it scrubbed of names, paths and code, finds it again when the
 * same message or question comes back, and counts whether it helped. The file stays on this machine.
 */

export const MAX_LOCAL_LESSONS = 300;

export class LessonError extends Error {}

/** $THREESMITH_HOME/lessons.json, else ~/.threesmith/lessons.json. */
export function localFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["THREESMITH_HOME"] || join(homedir(), ".threesmith"), "lessons.json");
}

export function emptyLocal(): LocalData {
  return { version: 1, lessons: [], stats: {} };
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** The local file, in the shape it should have; a missing or broken file reads as empty. */
export function readLocal(file = localFile()): LocalData {
  try {
    if (!existsSync(file)) return emptyLocal();
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const lessons: LocalLesson[] = [];
    for (const item of Array.isArray(raw["lessons"]) ? raw["lessons"] : []) {
      const lesson = lessonFrom(item);
      const added = (item as Record<string, unknown>)["added"];
      if (lesson?.id.startsWith("local/")) lessons.push({ ...lesson, added: typeof added === "string" ? added.slice(0, 10) : "" });
    }
    const stats: Record<string, LessonStats> = {};
    const rawStats = raw["stats"];
    if (rawStats && typeof rawStats === "object" && !Array.isArray(rawStats)) {
      for (const [id, s] of Object.entries(rawStats as Record<string, Record<string, unknown>>)) {
        if (LESSON_ID.test(id) && s && typeof s === "object") stats[id] = { helped: count(s["helped"]), wrong: count(s["wrong"]) };
      }
    }
    return { version: 1, lessons: lessons.slice(0, MAX_LOCAL_LESSONS), stats };
  } catch {
    return emptyLocal();
  }
}

/** Reads, changes and writes the local file atomically, readable only by this user. */
function updateLocal(change: (data: LocalData) => void, file = localFile()): LocalData {
  const data = readLocal(file);
  change(data);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    try {
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    // rename keeps the mode of the new file, but an older file may have been made by hand.
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } catch (e) {
    throw new LessonError(`not saved: ${(e as Error).message}`);
  }
  return data;
}

export interface LessonInput {
  title: string;
  fix: string;
  symptom?: string;
  cause?: string;
  topic?: string;
  tags?: string[];
  /** A message this lesson explains, as the browser or the build printed it; kept as a scrubbed template. */
  error?: string;
  rules?: string[];
  test?: string;
}

export interface Added {
  lesson: LocalLesson;
  /** What the scrubber replaced, by kind. */
  replaced: Record<string, number>;
  /** True when a lesson with the same title was updated instead. */
  updated: boolean;
}

const LIMITS = { title: 160, symptom: 600, cause: 600, fix: 600, test: 400 } as const;

function slug(text: string): string {
  return (
    text
      .replace(/<\w+>/g, " ")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 8)
      .join("-")
      .slice(0, 60)
      .replace(/-+$/, "") || "lesson"
  );
}

/**
 * A console message as a template to keep: scrubbed like the rest, with long numbers, quoted names and line
 * positions taken out so the same message from another file still matches.
 */
export function errorTemplate(message: string, context: ScrubContext = {}): string {
  const first = message.split("\n").find((l) => l.trim()) ?? "";
  const cleaned = first
    .replace(/\s+at\s+(?:\S+\s+)?\(?\S+:\d+:\d+\)?.*$/, "")
    .replace(/:\d+:\d+\b/g, "")
    // A quoted name stays when it is three's own or a plain word ("three", 'OrbitControls'), else it becomes <name>.
    .replace(/(["'])([^"'\n]{1,80})\1/g, (all, _q: string, inner: string) => (isKnownName(inner, context) || /^[a-z][\w.-]*$/.test(inner) ? all : "<name>"))
    .slice(0, 200);
  return scrubText(cleaned, context).text;
}

/**
 * Scrubs and checks a lesson before it is kept. Throws a LessonError that says what to change when too little is
 * left, so the agent can write it again in general words.
 */
export function prepareLesson(input: LessonInput, options: ScrubContext & { now?: Date } = {}): { lesson: Omit<LocalLesson, "id">; replaced: Record<string, number> } {
  const replaced: Record<string, number> = {};
  const clean = (field: keyof typeof LIMITS, value: string | undefined, required: boolean): string | undefined => {
    if (value === undefined || !value.trim()) {
      if (required) throw new LessonError(`${field} is required`);
      return undefined;
    }
    if (value.length > LIMITS[field] * 2) throw new LessonError(`${field} is too long (at most ${LIMITS[field]} characters): keep it to the point`);
    const out = scrubText(value, options);
    for (const [k, n] of Object.entries(out.replaced)) replaced[k] = (replaced[k] ?? 0) + n;
    const text = out.text.slice(0, LIMITS[field]).trim();
    const words = text.replace(/<\w+>/g, " ").match(/\p{L}{2,}/gu) ?? [];
    if (words.length < (field === "title" ? 2 : 3) || placeholderShare(text) > 0.4) {
      throw new LessonError(
        `too little is left of ${field} once names, paths and code are taken out ("${text}"). Write it as a general lesson in plain words, without names of the project, files or code.`,
      );
    }
    return text;
  };

  const title = clean("title", input.title, true)!;
  const fix = clean("fix", input.fix, true)!;
  const symptom = clean("symptom", input.symptom, false);
  const cause = clean("cause", input.cause, false);
  const test = clean("test", input.test, false);
  if (input.topic !== undefined && input.topic !== "" && !isTopic(input.topic)) throw new LessonError(`unknown topic "${input.topic}"`);
  const topic: LessonTopic = isTopic(input.topic) ? input.topic : "rendering";

  const tags = [
    ...new Set(
      (input.tags ?? [])
        .map((t) => scrubText(t, options).text.toLowerCase())
        .filter((t) => /^[\p{L}0-9 +.-]{2,30}$/u.test(t)),
    ),
  ].slice(0, 12);

  let errors: string[] | undefined;
  if (input.error?.trim()) {
    const template = errorTemplate(input.error, options);
    if (template.replace(/<\w+>/g, "").replace(/[^\p{L}]+/gu, "").length < 8) {
      throw new LessonError("too little of the message is left once names and paths are taken out; pass the message text itself");
    }
    errors = [template];
  }
  const rules = (input.rules ?? []).filter((r) => /^[a-z0-9-]{2,60}$/.test(r)).slice(0, 5);

  const lesson: Omit<LocalLesson, "id"> = {
    topic,
    title,
    symptom: symptom ?? title,
    cause: cause ?? "(not written down)",
    fix,
    tags,
    added: (options.now ?? new Date()).toISOString().slice(0, 10),
    ...(rules.length ? { rules } : {}),
    ...(test ? { test } : {}),
    ...(errors ? { errors } : {}),
  };
  return { lesson, replaced };
}

/** Keeps a lesson learned here. The same title again updates that lesson (and merges its messages and tags). */
export function addLocalLesson(input: LessonInput, options: ScrubContext & { now?: Date } = {}): Added {
  const { lesson, replaced } = prepareLesson(input, options);
  let result: Added | undefined;
  updateLocal((d) => {
    const id = `local/${slug(lesson.title)}`;
    const existing = d.lessons.find((l) => l.id === id);
    if (existing) {
      const errors = [...new Set([...(existing.errors ?? []), ...(lesson.errors ?? [])])].slice(0, 8);
      const tags = [...new Set([...existing.tags, ...lesson.tags])].slice(0, 12);
      Object.assign(existing, lesson, { id, tags, ...(errors.length ? { errors } : {}) });
      result = { lesson: existing, replaced, updated: true };
      return;
    }
    if (d.lessons.length >= MAX_LOCAL_LESSONS) throw new LessonError(`there are already ${MAX_LOCAL_LESSONS} local lessons; remove some first`);
    const added: LocalLesson = { id, ...lesson };
    d.lessons.push(added);
    result = { lesson: added, replaced, updated: false };
  });
  return result!;
}

/** The lessons learned on this machine, newest first. */
export function listLocal(): LocalLesson[] {
  return [...readLocal().lessons].reverse();
}

export function removeLocalLesson(id: string): boolean {
  let removed = false;
  updateLocal((d) => {
    const before = d.lessons.length;
    d.lessons = d.lessons.filter((l) => l.id !== id);
    removed = d.lessons.length < before;
    if (removed) delete d.stats[id];
  });
  return removed;
}

export type LessonVerdict = "helped" | "wrong";

/** Feedback on a lesson, bundled or local: it helped, or it did not fit. Unknown ids are refused. */
export function recordLessonFeedback(id: string, verdict: LessonVerdict): LessonStats & { id: string } {
  const local = readLocal();
  const found = findLesson(id, local);
  if (!found) throw new LessonError(`no lesson "${id}"`);
  const key = found.lesson.id;
  const data = updateLocal((d) => {
    const s = (d.stats[key] ??= { helped: 0, wrong: 0 });
    if (verdict === "helped") s.helped++;
    else s.wrong++;
  });
  return { id: key, ...data.stats[key]! };
}
