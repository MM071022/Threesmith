---
name: perf
description: Use when a three.js page is slow, stutters, has low fps, loads slowly, uses too much memory or GPU memory, heats a phone, or when asked to optimise a three.js scene. Measures first (draw calls, triangles, programs, textures, frame times), finds the cause with the review and lessons from real projects, changes one thing at a time and measures again. Also in Dutch: "het hapert", "traag", "lage fps", "sneller maken", "laadtijd", "geheugen loopt op".
argument-hint: "[what is slow, optional]"
---

# Make a three.js scene faster, measured

Work on $ARGUMENTS (or what the user named). Never optimise without a number before and after.

1. **Measure first.** `three_perf` on the page (with `steps` for what happens in it) gives draw calls, triangles,
   programs, geometries and textures (exact, the same on every GPU) and frame times (relative: headless Chromium draws
   in software, so compare runs, do not quote them as real fps). It keeps the last run and shows the change.
2. **Let the review point.** `three_review` and read the `performance` category: allocations in the loop, geometry or
   materials made per frame, scene traversal per frame, uncapped pixel ratio, huge shadow maps, many meshes that
   should be instanced. `three_assets` names textures above 4096 and big uncompressed models.
3. **Ask what real projects learned.** `three_lessons` with topic `performance` or the symptom ("many draw calls",
   "hitch when a model loads", "shader compile stutter").
4. **One change at a time.** Typical wins, biggest first: fewer draw calls (InstancedMesh, BatchedMesh, merged static
   geometry, shared materials), pixel ratio capped at 2, compressed models (Draco or meshopt) and textures (KTX2),
   smaller shadow maps with a tight shadow camera, `renderer.compileAsync` before the first frame, work moved out of
   the loop.
5. **Measure again** with `three_perf`, the same case. Keep the change only when the numbers say so.
6. **Memory that grows** while the user switches levels or opens and closes things: `three_leaks` with the steps of
   one cycle. It says what grows per cycle (geometries, textures, objects by type); after the fix it must be 0.

End with a table: change, before, after, kept or dropped.
