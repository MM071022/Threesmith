# Privacy

Threesmith runs on your machine and sends nothing anywhere.

- It reads the files of the project you point it at, and the installed `three` package, to answer lookups and reviews.
- The browser check starts a local web server on `127.0.0.1` (random port) that serves only the folder you give it, and
  a local headless Chromium. The page may load whatever its own code loads (for example a CDN).
- It writes screenshots, baselines and diffs under `.threesmith/` in the project folder. Nothing else is stored.
- No telemetry, no accounts, no network calls of its own.
