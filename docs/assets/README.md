# Website assets

The robot preview is real Threesmith output: `model build robot --param scheme=1 -o robot.glb`.
It is served as `robot.glb.gz` and decompressed in the browser, then loaded by three.js.
`robot.json` records the builder's actual measurements. No services or telemetry are used.
The viewer pauses rendering offscreen and honors reduced motion; the poster remains available
without WebGL, JavaScript, or native gzip decompression support.

Run `npm run build:site` to rebuild the model, metadata and self-hosted viewer from
`scripts/site/viewer.js`. three.js r187 is bundled under the MIT license in
`three-LICENSE.txt`. Rolldown is a development dependency, already used by the test runner.
CI verifies that the checked-in preview assets match their source.

`scripts/site.mjs` still refreshes the real CLI output blocks in the home page.
`scripts/models-page.py` still refreshes the full model catalogue with the shared stylesheet.
`node scripts/og.mjs` exports the social preview and icons; it needs Chromium and a built CLI.
The poster is a render of the actual model, and gallery images are actual three.js renders.
