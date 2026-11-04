import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // THREESMITH_HOME points at a temp folder, so tests never touch the real learning and lessons files
    setupFiles: ["test/setup.ts"],
    testTimeout: 60000,
  },
});
