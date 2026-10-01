import reactHooks from "eslint-plugin-react-hooks";
import react from "@eslint-react/eslint-plugin";
import js from "@eslint/js";
import { processBoundaries } from "./scripts/eslint-boundaries.mjs";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "out/**",
      "build/**",
      "coverage/**",
      "inspiration/**",
      ".husky/_/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: globals.node },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  {
    files: ["**/*.{ts,tsx,mts}"],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.main.json", "./tsconfig.renderer.json", "./tsconfig.tests.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { foom: { rules: { "process-boundaries": processBoundaries } } },
    rules: { "foom/process-boundaries": "error" },
  },
  {
    files: ["**/*.tsx"],
    extends: [reactHooks.configs.flat.recommended, react.configs["recommended-typescript"]],
  },
  { files: ["tests/electron/*.js"], languageOptions: { globals: globals.browser } },
);
