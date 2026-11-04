---
name: review
description: Review this three.js project with Threesmith and fix what it finds, errors first, re-reviewing after each fix, then open the page headless.
disable-model-invocation: true
argument-hint: "[files or folder, optional]"
---

# Review and fix

Review the three.js project (or only $ARGUMENTS) and fix what the review finds.

1. `three_scan` once, so you know the stack, the pages, the files that use three and the renderer settings.
2. `three_review` (pass the files from $ARGUMENTS as `files`). Show the user the score, the score per category and
   the number of errors, warnings and notes. In a TypeScript project also `three_types`.
3. `three_fix` (dry run, then `write: true`) for the renames it can do; `three_undo` if it went wrong.
4. Fix the remaining errors, then the warnings, one file at a time. Look up every API you change with `three_api`.
   After each file, `three_review` with `only_new: true`.
5. `three_assets` when the code loads models or textures.
6. Leave notes the user did not ask about; list them at the end.
7. Finish with `three_check` on the page and look at the screenshot.
8. End with the score before and after, what changed per file, and what needs a decision from the user. Report
   verified false alarms with `three_feedback`.

Do not change what the scene shows to make a finding go away. If a fix would change it, ask first.
