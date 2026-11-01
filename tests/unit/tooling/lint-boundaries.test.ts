import { resolve } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, test } from "vitest";
import { processBoundaries } from "../../../scripts/lint-boundaries.mjs";

RuleTester.describe = describe;
RuleTester.it = test;

const invalid: [string, string][] = [
  ["cli/example.ts", 'import "../main/main";'],
  ["cli/example.ts", 'import "electron";'],
  ["node-common/example.ts", 'import "electron";'],
  ["renderer/example.ts", 'import "../node-common/private-files";'],
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
];
const valid: [string, string][] = [
  ["renderer/example.ts", 'import { TerminalColors } from "../shared/terminal-colors";'],
  ["renderer/example.ts", 'import { Board } from "./board/board-view";'],
  ["cli/example.ts", 'import "../node-common/private-files";'],
  ["main/example.ts", 'import "../node-common/private-files";'],
  ["main/example.ts", 'import { app } from "electron";'],
  ["main/example.ts", 'import { readFile } from "node:fs/promises";'],
  ["terminal-host/example.ts", 'import { Terminal } from "@xterm/headless";'],
  ["shared/example.ts", 'import type { IParser } from "@xterm/xterm";'],
  ["shared/example.ts", 'export type { HostRequest } from "./terminal-host";'],
  ["preload/example.ts", 'import { isBoardCommand } from "../shared/board-commands";'],
  ["preload/example.ts", 'import { contextBridge } from "electron";'],
  ["preload/example.ts", 'import type { DesktopApi } from "../shared/desktop";'],
  ["preload/example.ts", 'import { type DesktopApi } from "../shared/desktop";'],
];

new RuleTester().run("process-boundaries", processBoundaries, {
  invalid: invalid.map(([file, code]) => ({
    filename: resolve("src", file),
    code: code,
    errors: 1,
  })),
  valid: valid.map(([file, code]) => ({
    filename: resolve("src", file),
    code: code,
  })),
});
