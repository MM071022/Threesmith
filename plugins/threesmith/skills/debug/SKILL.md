---
name: debug
description: Use when a three.js page is black, empty, washed out, stretched or wrong, when the console, a build or a test prints a three.js error or warning ("is not a constructor", "does not provide an export named", "Unexpected token '<'", "Context Lost", a shader error, "Multiple instances of Three.js"), or when the scene behaves wrong (a model is invisible or tiny, shadows do not draw, clicks hit nothing, memory grows). Finds the cause from the files and the running page, fixes it and proves the fix. Also in Dutch: "zwart scherm", "ik zie niks", "model laadt niet", "werkt niet", "fout in de console".
argument-hint: "[error message or symptom, optional]"
---

# Debug a three.js problem

Find the cause of the problem ($ARGUMENTS, or what the user described), fix it and prove the fix. Do not guess: every
step answers from the project, from the installed three or from the running page.

1. **Start from the files.** `three_doctor` puts the most likely causes first: versions and imports, why the scene
   shows nothing, assets that will not load, removed APIs. Fix what it names in the order it gives.
2. **Get the exact message.** `three_check` on the page (a folder with `index.html`, or the dev server URL) prints
   every console and page error with its likely cause, failed requests and a screenshot; shader errors name your file
   and line. A blank or wrong picture: `three_inspect` says per object why it is not visible (no light, camera inside,
   beyond `far`, zero scale, NaN, layers, invisible material).
3. **Ask what real projects learned.** `three_lessons` with the message as `error`, or with words for the symptom
   ("model too dark", "shadows cut off", "click hits nothing"). `three_explain` gives the cause of one message.
4. **Reproduce in a live page** when the state is hard to reach: `three_session` op start once, then `three_page`
   op steps to get there, op eval to read values (`$('player').position`, `renderer.info.render`), op until to wait
   for the moment it goes wrong. After an edit, op reload.
5. **Name the cause in one sentence** in three.js terms (which object, which property, which frame) before you change
   anything. Check every API on the path with `three_api`: removed names, wrong import paths and changed defaults are
   the usual cause.
6. **Fix the cause, not the symptom.** No `if (!model) return` around a model that should be loaded: await the
   loader. No brighter lights to hide a colour space bug. `three_review` with `only_new: true` after the change.
7. **Prove it.** The same `three_check`, `three_inspect` or `three_play` with `expect`, before and after. Keep a
   `three_play` proof as a regression test with `three_scenario` op save.
8. **Teach it back.** When the fix took more than one try, `three_lesson_add` (general words, the message as printed,
   no names or code).

End with: the message, the cause in one sentence, the fix per file, and the proof.
