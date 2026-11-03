---
name: threesmith
description: Use when writing, changing or debugging three.js code. Looks up the exact API of the installed three version, reviews code for outdated or broken patterns, and checks the page in headless Chromium. Prevents the classic mistakes: removed APIs (Geometry, outputEncoding), wrong import paths, black scenes, shadows that never draw, per-frame allocations.
---

# Threesmith for three.js

three.js changes every month. Do not write API calls from memory; check them against the installed version.

## Workflow

1. **Before writing code that uses an API you are not sure of**, call `three_api` (CLI: `threesmith api <Name>` or
   `<Class.member>`). It reads the installed three, so the answer is right for this project. Use `three_search` to find
   a name. If a name is "not exported", it does not exist in this version: do not invent it.
2. **After writing or changing three.js code**, call `three_review` (CLI: `threesmith review`). Fix every error first,
   `three_fix` applies the pure renames (dry run unless `write`); then fix the rest by hand, then the warnings that apply. Do not silence a rule to get a better score; if a finding is wrong, say so.
3. **Before saying a scene works**, call `three_check` on the folder with the page (CLI: `threesmith check <folder>`).
   It reports console errors, missing canvas or WebGL context, blank frames and returns a screenshot. Look at the
   screenshot. Use `baseline` to catch visual regressions after a change, and `steps` (click, press, drag, wheel) to reach a state that only shows after an interaction.

## Rules of thumb

- Import addons from `three/addons/...`, not `three/examples/jsm/...`. `OrbitControls`, `GLTFLoader` etc. are not in `three`.
- `WebGPURenderer` and node materials come from `three/webgpu`, and need `await renderer.init()` (or `setAnimationLoop`).
- Color textures need `texture.colorSpace = THREE.SRGBColorSpace`. `outputEncoding` and `*Encoding` are gone.
- Shadows need `renderer.shadowMap.enabled = true`, a light with `castShadow`, and meshes with `castShadow`/`receiveShadow`.
- Never `new` a Vector3/Matrix4/geometry/material inside the animation loop. Call `dispose()` on what you remove.
- After changing `camera.aspect`, call `camera.updateProjectionMatrix()`.
- WebGPU in the headless check is best effort. WebGL 2 is the reliable path.
