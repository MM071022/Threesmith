---
name: learn
description: Teach Threesmith what this session learned about three.js, anonymously and on this machine only, so the next session (and every later review and check) starts smarter.
disable-model-invocation: true
argument-hint: "[what to focus on, optional]"
---

# Teach Threesmith what you learned

Threesmith learns on this machine: which findings were false alarms, and the lessons you keep. Nothing is sent
anywhere.

1. **Go over this session** (or only $ARGUMENTS). For every problem that took more than one try, ask: is there a
   general lesson in it that another three.js project could use? Check `three_lessons` first: do not keep a lesson
   that is already there or that a review rule already reports (`three_rules`).
2. **Keep each lesson with `three_lesson_add`**, in general words:
   - `title`: the lesson in one line ("A glTF texture applied by hand needs flipY = false").
   - `symptom`, `cause` (in three.js terms) and `fix`; `test` when you know how to check it.
   - `error`: the console or build message exactly as printed, so `three_check` and `three_explain` show the lesson the
     next time it appears.
   - No project names, file names or code: Threesmith scrubs them anyway. Show the user what was stored.
3. **Mark false alarms.** For every review finding you verified as wrong, `three_feedback` with its file, line and
   verdict wrong. It is hidden from then on, on this machine only.
4. **End with a short list:** the lessons kept (their ids) and the feedback given.

Never keep secrets, personal data or code in a lesson.
