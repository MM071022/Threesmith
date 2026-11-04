/** Shapes of data/lessons.json and of the lessons learned on this machine. */

export const LESSON_TOPICS = [
  "rendering",
  "color",
  "lighting",
  "shadows",
  "loading",
  "models",
  "imports",
  "build",
  "performance",
  "memory",
  "interaction",
  "animation",
  "webgpu",
  "r3f",
  "shaders",
  "tooling",
] as const;

export type LessonTopic = (typeof LESSON_TOPICS)[number];

export interface Lesson {
  /** Stable id, `topic/short-name`; lessons learned on this machine start with `local/`. */
  id: string;
  topic: LessonTopic;
  /** One line: the lesson itself. */
  title: string;
  /** What went wrong, as it shows on screen or in the console. */
  symptom: string;
  /** Why, in three.js terms. */
  cause: string;
  /** What to do instead. */
  fix: string;
  /** Review rules (src/review/rules.ts) that catch it. */
  rules?: string[];
  /** How to check the fix when no rule catches it. */
  test?: string;
  /** Words people use for it, for search. */
  tags: string[];
  /**
   * Fragments of console or build messages that point to it, matched without case. Local lessons keep a scrubbed
   * template in which `<kind>` placeholders match any text.
   */
  errors?: string[];
}

export interface LessonLibrary {
  version: 1;
  lessons: Lesson[];
}

/** Whether a lesson helped, kept per lesson id on this machine. */
export interface LessonStats {
  helped: number;
  wrong: number;
}

/** A lesson learned on this machine: the same fields, scrubbed of names, paths and code, plus the day it was added. */
export interface LocalLesson extends Lesson {
  added: string;
}

/** The local file: lessons learned here and feedback on every lesson. Never sent anywhere. */
export interface LocalData {
  version: 1;
  lessons: LocalLesson[];
  stats: Record<string, LessonStats>;
}
