# Benchmark: does Threesmith make agents better at three.js?

This folder holds the tasks and the grader. **No results are published yet.** Numbers go here only after real
runs, with the raw outputs attached, so anyone can rerun them.

## Method

Two arms, same model, same prompts, same three.js version (`three@0.187.0`):

- **baseline**: the agent with its normal tools.
- **threesmith**: the same agent with the Threesmith MCP server (`threesmith mcp`) and the skill in `plugins/threesmith/skills/threesmith`.

For each task in `tasks/tasks.json`, run each arm N times (N >= 10, fresh empty directory with `npm i three@0.187.0`),
then grade the produced directory:

```sh
node bench/grade.mjs spinning-cube path/to/output --three path/to/output/node_modules/three --root path/to/output
```

The grader is deterministic and has no model in it. A task passes when:

1. the review score is at least `minScore`,
2. none of the `mustNotFire` rules fired,
3. where `check` is true, the page opens in headless Chromium without console errors, creates a WebGL context and is not blank.

Report pass rate per task and arm with the number of runs, and keep the outputs.

## Limits to state with any result

- The review rules and the grader come from the same project. A pass means "no known mistake", not "good".
  Use the browser check and a human look at the screenshots too.
- Software WebGL (SwiftShader) renders differently from a real GPU.
- Tasks are small. They show the effect on common mistakes, not on large applications.
