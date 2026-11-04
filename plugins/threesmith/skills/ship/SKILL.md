---
name: ship
description: Use before a three.js page is deployed or called done — a production build, GitHub Pages, Netlify, Vercel or any static host. Builds it, checks the output (two copies of three, missing assets, absolute paths that break under a sub-path, file names that differ only in case, decoder files) and opens the built page headless. Also in Dutch: "deployen", "online zetten", "werkt lokaal maar niet online", "build".
argument-hint: "[where it will be hosted, optional]"
---

# Ship a three.js page

Make sure what works in the dev server also works where it is hosted ($ARGUMENTS, or what the user named).

1. `three_assets`: every path the code loads resolves, with the exact capitals (Linux hosts are case-sensitive), and
   Draco/KTX2 decoder files are where the loaders look.
2. `three_build`: runs the project's build, checks the output folder (more than one copy of three bundled, assets the
   bundle refers to that are not in the output, `/assets/...` paths that break under a sub-path such as
   `user.github.io/repo/`, size of three in the bundle) and opens the built page headless.
3. For a sub-path host, set the bundler's base (`base: '/repo/'` in vite.config) and run `three_build` again.
4. `three_check` on the built folder with a `baseline` you approved, so the deploy shows the same picture.
5. In CI: the GitHub Action posts the review and the check as a receipt on every pull request.

End with: the build result, the problems found and fixed, and the screenshot of the built page.
