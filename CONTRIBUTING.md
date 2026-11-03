# Contributing to Threesmith

Thanks for helping. Small fixes and big ideas are both welcome.

## Ways to help

- **Report a wrong finding**: open an issue with the code snippet, the three version and the rule id. False alarms and
  missed mistakes are the most useful reports.
- **Suggest a rule** for a mistake agents keep making in three.js. Link the migration guide or changelog entry.
- Pick an issue labeled `good first issue`.
- Run the benchmark (`bench/README.md`) with your agent and share the raw outputs.

## Adding a rule

1. Add it to `src/review/rules.ts` with an `id`, a `category`, a `severity`, a message and a concrete fix.
2. Set `removedIn` / `introducedIn` / `deprecatedIn` only for releases you verified (changelog, migration guide, or the
   source of that release). Unsure: leave it out.
3. Add a test that fires and one that stays quiet in `test/review.test.ts`.
4. `npm run check` must pass, including the "no false alarms on three's own addons" test.

## Set up

```sh
npm ci
npm run check
```

The headless tests need Chromium (`npx playwright-core install chromium`, or set `THREESMITH_CHROMIUM`).
