#!/usr/bin/env node
import { buildProgram } from "./program.js";

buildProgram()
  .parseAsync(process.argv)
  .catch((e: unknown) => {
    process.stderr.write(`threesmith: ${(e as Error).message}\n`);
    process.exitCode = 2;
  });
