# Security

## Report a vulnerability

Report it privately through
[GitHub security advisories](https://github.com/laaielichter/Threesmith/security/advisories/new).
Please do not open a public issue for it. A fix for a confirmed problem goes out in a new release on npm.

Only the latest release is supported.

## What Threesmith does on your machine

- It reads the files of the project you point it at and the installed `three` package. It never executes project code
  for the API lookup or the review: they only read text.
- `check` (and `three_check`) opens a page in a headless Chromium, which **runs the page's own scripts**. Treat pages of
  people you do not trust like any other code you run. Its static server listens on `127.0.0.1` only and serves nothing
  outside the folder you give it.
- It writes only `.threesmith/` (screenshots, baselines, diffs) in the folder it checks.
- Nothing leaves your machine; see [PRIVACY.md](PRIVACY.md).

## How releases are made

- npm releases are published by GitHub Actions with
  [trusted publishing](https://docs.npmjs.com/trusted-publishers) and carry a
  [provenance statement](https://docs.npmjs.com/generating-provenance-statements), so you can check that a version
  was built from this repository: `npm audit signatures`.
- Every GitHub Action the workflows use is pinned to a commit, and checkouts do not keep git credentials.
- CodeQL scans the code and the workflows; Dependabot proposes dependency updates every week.
