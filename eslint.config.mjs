import js from "@eslint/js";
import { builtinModules } from "node:module";
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
    files: ["**/*.{ts,mts}"],
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
    files: ["src/renderer/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["electron", ...builtinModules.filter((name) => !name.startsWith("node:"))],
          patterns: [
            {
              group: ["node:*", "**/main", "**/main.*", "**/preload", "**/preload.*"],
              message: "Use the typed preload bridge; renderer code must stay browser-only.",
            },
          ],
        },
      ],
    },
  },
  { files: ["test/*.js"], languageOptions: { globals: globals.browser } },
);
