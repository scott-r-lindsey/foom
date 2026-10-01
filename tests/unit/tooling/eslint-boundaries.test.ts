import { Linter } from "eslint";
import { resolve } from "node:path";
import tseslint from "typescript-eslint";
import { expect, test } from "vitest";
import { processBoundaries } from "../../../scripts/eslint-boundaries.mjs";

function lint(file: string, code: string) {
  return new Linter().verify(
    code,
    {
      files: ["**/*.ts"],
      languageOptions: { parser: tseslint.parser },
      plugins: { foom: { rules: { "process-boundaries": processBoundaries } } },
      rules: { "foom/process-boundaries": "error" },
    },
    { filename: resolve("src", file) },
  );
}

test.each([
  ["renderer/board/example.ts", 'import { Workspace } from "../../main/workspace/workspace";'],
  ["renderer/example.ts", 'export * from "../main/setup/settings";'],
  ["renderer/example.ts", 'import("../terminal-host/terminal-manager");'],
  ["renderer/example.ts", 'import * as fs from "node:fs";'],
  ["renderer/example.ts", 'const fs = require("fs/promises");'],
  ["renderer/example.ts", 'import host = require("../terminal-host/terminal-host");'],
  ["main/example.ts", 'import type { ShellView } from "../renderer/terminal/shell.d";'],
  ["main/example.ts", 'import "../terminal-host/terminal-host";'],
  ["terminal-host/example.ts", 'import "../main/main";'],
  ["shared/example.ts", 'import { app } from "electron";'],
  ["shared/example.ts", 'import "node-pty";'],
  ["shared/example.ts", 'export * from "../main/setup/settings";'],
  ["preload/example.ts", 'import { hostRequest } from "../shared/terminal-host-protocol";'],
  ["preload/example.ts", 'import "node:fs";'],
  ["preload/example.ts", 'import type { Workspace } from "../main/workspace/workspace";'],
])("rejects a forbidden dependency in %s: %s", (file, code) => {
  const messages = lint(file, code);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.ruleId).toBe("foom/process-boundaries");
});

test.each([
  ["renderer/example.ts", 'import { TerminalColors } from "../shared/terminal-colors";'],
  ["renderer/example.ts", 'import { Board } from "./board/board-view";'],
  ["main/example.ts", 'import { app } from "electron";'],
  ["main/example.ts", 'import { readFile } from "node:fs/promises";'],
  ["terminal-host/example.ts", 'import { Terminal } from "@xterm/headless";'],
  ["shared/example.ts", 'import type { IParser } from "@xterm/xterm";'],
  ["shared/example.ts", 'export type { HostRequest } from "./terminal-host";'],
  ["preload/example.ts", 'import { contextBridge } from "electron";'],
  ["preload/example.ts", 'import type { DesktopApi } from "../shared/desktop";'],
  ["preload/example.ts", 'import { type DesktopApi } from "../shared/desktop";'],
])("allows an intended dependency in %s: %s", (file, code) => {
  expect(lint(file, code)).toEqual([]);
});
