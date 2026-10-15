import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bound local IO/process contention; CLI --maxWorkers=1 still serializes native tests.
    maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)),
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    setupFiles: ["tests/helpers/setup.js"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "json-summary", "lcov", "html"],
      include: ["src/**/*.{ts,tsx}"],
      // Declaration files have no executable code.
      exclude: ["src/**/*.d.ts"],
      thresholds: { perFile: true, lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
