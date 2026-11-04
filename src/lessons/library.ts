import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LESSON_TOPICS, type Lesson, type LessonLibrary, type LessonTopic } from "./types.js";

/**
 * The lessons that ship with Threesmith, in data/lessons.json at the package root. This file sits in src/lessons/
 * when run from source and in dist/lessons/ when built; both are two levels below the root, but the folder is found
 * by walking up so a different layout (a bundle) still works.
 */
export function lessonsFile(from: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = from;
  for (let i = 0; i < 5; i++) {
    const file = join(dir, "data", "lessons.json");
    if (existsSync(file) && existsSync(join(dir, "package.json"))) return file;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

let cached: Lesson[] | undefined;

/** The bundled lessons. Empty when the file is missing or broken: lessons are a help, never a reason to fail. */
export function bundledLessons(): Lesson[] {
  if (cached) return cached;
  try {
    const file = lessonsFile();
    cached = file ? parseLessons(JSON.parse(readFileSync(file, "utf8"))) : [];
  } catch {
    cached = [];
  }
  return cached;
}

export function isTopic(value: unknown): value is LessonTopic {
  return typeof value === "string" && (LESSON_TOPICS as readonly string[]).includes(value);
}

export const LESSON_ID = /^[a-z0-9]+\/[a-z0-9-]+$/;

const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);
const list = (v: unknown, max: number): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() && x.length <= max) ? (v as string[]).map((x) => x.trim()) : undefined;

/** One lesson in the shape it should have, or undefined: a hand edit must not break a tool. */
export function lessonFrom(v: unknown): Lesson | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const id = text(r["id"], 80);
  const title = text(r["title"], 200);
  const symptom = text(r["symptom"], 800);
  const cause = text(r["cause"], 800);
  const fix = text(r["fix"], 800);
  if (!id || !LESSON_ID.test(id) || !isTopic(r["topic"]) || !title || !symptom || !cause || !fix) return undefined;
  const lesson: Lesson = { id, topic: r["topic"], title, symptom, cause, fix, tags: list(r["tags"], 40) ?? [] };
  const rules = list(r["rules"], 80);
  if (rules?.length) lesson.rules = rules;
  const test = text(r["test"], 600);
  if (test) lesson.test = test;
  const errors = list(r["errors"], 200);
  if (errors?.length) lesson.errors = errors;
  return lesson;
}

export function parseLessons(value: unknown): Lesson[] {
  const lib = value as Partial<LessonLibrary> | undefined;
  if (!lib || lib.version !== 1 || !Array.isArray(lib.lessons)) return [];
  const seen = new Set<string>();
  const out: Lesson[] = [];
  for (const item of lib.lessons) {
    const lesson = lessonFrom(item);
    if (lesson && !seen.has(lesson.id)) {
      seen.add(lesson.id);
      out.push(lesson);
    }
  }
  return out;
}
