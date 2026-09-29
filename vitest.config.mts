import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "json-summary", "lcov", "html"],
      include: ["src/**/*.ts"],
      // Declaration files have no executable code.
      exclude: ["src/**/*.d.ts"],
      thresholds: { perFile: true, lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
