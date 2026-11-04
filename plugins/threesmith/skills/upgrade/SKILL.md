---
name: upgrade
description: Upgrade old three.js code (Geometry, examples/js, BufferGeometry aliases, outputEncoding, legacy lights, an old release pinned on a CDN) to the release installed in this project, or move a project to a newer three release, with Threesmith checking every step.
disable-model-invocation: true
argument-hint: "[folder or file, or the release to move to, optional]"
---

# Upgrade three.js code

Bring the project (or $ARGUMENTS) up to the installed three release.

1. `three_version` and `three_scan`: which release is installed, which one the code was written for (CDN URLs,
   `@types/three`, import paths), and whether `three` and `three/webgpu` are mixed.
2. `three_review` and count the `api` findings. This is the "before" picture; show it.
3. `three_fix` without `write`, show what it will change, then with `write: true`. It only does renames that mean
   exactly the same thing.
4. Do the rest by hand, one rule at a time, with `three_api` for every replacement (it reads the installed release):
   `Geometry` to `BufferGeometry` with attributes, `examples/js` to `three/addons/...` modules with an import map,
   light intensities for physical units after `useLegacyLights`, texture `colorSpace` instead of `encoding`.
5. `three_review` with `only_new: true` after each file until no `api` errors are left; `three_types` in TypeScript.
6. `three_check` on the page before and after; with a `baseline` from before the upgrade, the diff shows what changed
   on screen (colours and light levels usually do after r152 and r155: say so, do not hide it).
7. End with the counts before and after, the hand-made changes, and what looks different now.
