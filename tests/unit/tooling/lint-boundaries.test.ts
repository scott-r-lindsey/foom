import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";
import { afterAll, describe, expect, test } from "vitest";
import {
  areaBoundaries,
  areaPolicy,
  processBoundaries,
  validateAreaPolicy,
} from "../../../scripts/lint-boundaries.mjs";

RuleTester.describe = describe;
RuleTester.it = test;

const invalid: [string, string][] = [
  ["terminal-host/example.ts", 'import "../node-common/private-files";'],
  ["renderer/example.ts", 'import "../node-common/vendor-install";'],
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
  ["terminal-host/example.ts", 'import "../node-common/vendor-install";'],
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

const aliasDirectory = resolve("src/main");
writeFileSync(
  resolve(aliasDirectory, "package.json"),
  JSON.stringify({
    imports: {
      "#workspace": "./workspace/worktrees.ts",
      "#internal": "./workspace/worktree-store.ts",
      "#missing-file": "./agents/does-not-exist.ts",
      "#blocked": null,
      "#allowed": "./agents/agents.ts",
      "#patterns/*": "./workspace/*.ts",
      "#agents*agents": "./agents/agents.ts",
      "#two*stars*": "./agents/agents.ts",
      "#conditional": { import: "./agents/agents.ts", require: "./workspace/worktrees.ts" },
    },
  }),
  { flag: "wx" },
);
afterAll(() => {
  rmSync(resolve(aliasDirectory, "package.json"));
});
const aliasFile = resolve(aliasDirectory, "agents/example.ts");

const areaValid: [string, string][] = [
  ["main/data-import/example.ts", 'import { ProfileDatabase } from "../data/sqlite/database";'],
  ["main/data-import/example.ts", 'import { parseMessageBoard } from "../control/message-board";'],
  [
    "main/data-import/example.ts",
    'import type { ReviewCheckout } from "../workspace/review-worktrees";',
  ],
  ["main/wiring/example.ts", 'import { importLegacy } from "../data-import/importer";'],
  ["main/wiring/example.ts", 'import "../setup/github-sign-in";'],
  ["main/workspace/example.ts", 'import { AgentService } from "../agents/agents";'],
  ["main/workspace/example.ts", 'import { helper } from "./internal";'],
  ["main/workspace/example.ts", "import(`./internal`);"],
  ["main/workspace/example.ts", "require(`./internal`);"],
  ["main/workspace/example.ts", 'import type { Shell } from "../../shared/workspace";'],
  ["main/agents/example.ts", 'import type { WorktreeService } from "../workspace/worktrees";'],
  ["main/agents/example.ts", 'import { type WorktreeService } from "../workspace/worktrees.js";'],
  ["main/agents/example.ts", 'export type { WorktreeService } from "../workspace/worktrees";'],
  ["main/agents/example.ts", 'export { type WorktreeService } from "../workspace/worktrees";'],
  ["main/agents/example.ts", 'type Service = import("../workspace/worktrees").WorktreeService;'],
  ["main/wiring/example.ts", 'import { Workspace } from "../workspace/workspace";'],
  ["main/wiring/example.ts", 'import { ThemeLibrary } from "../themes/library";'],
  ["main/main.ts", 'import { runApplication } from "./wiring/application";'],
  ["renderer/board/example.tsx", 'import { TerminalMenu } from "../terminal/terminal-menu";'],
  ["renderer/board/example.tsx", 'export * from "../terminal/terminal-menu";'],
  ["renderer/board/example.tsx", 'import("../terminal/terminal-menu");'],
  ["renderer/board/example.tsx", 'const menu = require("../terminal/terminal-menu");'],
  ["renderer/board/example.tsx", 'import menu = require("../terminal/terminal-menu");'],
  ["renderer/board/example.tsx", 'import { useState } from "react";'],
  ["renderer/board/example.tsx", 'import type { SetupSource } from "../preflight/setup-source";'],
  ["renderer/board/example.tsx", 'import type { SetupSource } from "../preflight/setup-source.d";'],
  [
    "renderer/board/example.tsx",
    'import type { SetupSource } from "../preflight/setup-source.d.ts";',
  ],
  ["renderer/app.tsx", 'import { Board } from "./board/board-view";'],
  ["main/workspace/example.ts", 'import { profile } from "../profile";'],
];
const areaInvalid: [string, string, string][] = [
  ["main/data/example.ts", 'import "../data-import/importer";', "edge"],
  ["main/data/example.ts", 'import type { SecretCipher } from "../setup/environment";', "edge"],
  ["main/data/example.ts", 'import "../window/window-placement";', "types"],
  ["main/setup/example.ts", 'import "../data-import/importer";', "edge"],
  ["main/data-import/example.ts", 'import "../control/service";', "entry"],
  ["main/data-import/example.ts", 'import "../data/view-registry";', "entry"],
  ["main/data-import/example.ts", 'import "../terminals/terminal-ipc";', "edge"],
  ["main/wiring/example.ts", 'import "../data-import/legacy-batch";', "entry"],
  ["main/agents/example.ts", "import(`../workspace/worktrees`);", "types"],
  ["main/agents/example.ts", "require(`../workspace/worktrees`);", "types"],
  ["main/agents/example.ts", "import(`../workspace/${name}`);", "unresolved"],
  ["main/agents/example.ts", "require(`../workspace/${name}`);", "unresolved"],
  ["main/agents/example.ts", "import(path);", "unresolved"],
  ...["cts", "mts", "js", "cjs", "mjs"].flatMap<[string, string, string]>((extension) => [
    [`main/agents/new-file.${extension}`, 'import("../workspace/worktrees");', "types"],
    [`renderer/new-area/new-file.${extension}`, "const local = 1; void local;", "unknown"],
  ]),
  ["main/terminals/example.ts", 'import type { Workspace } from "../workspace/workspace";', "edge"],
  ["main/agents/example.ts", 'import { WorktreeService } from "../workspace/worktrees";', "types"],
  [
    "main/agents/example.ts",
    'import { type WorktreeService, runtime } from "../workspace/worktrees";',
    "types",
  ],
  ["main/agents/example.ts", 'import "../workspace/worktrees";', "types"],
  ["main/agents/example.ts", 'export * from "../workspace/worktrees";', "types"],
  ["main/agents/example.ts", 'import("../workspace/worktrees");', "types"],
  ["main/agents/example.ts", 'require("../workspace/worktrees");', "types"],
  ["main/agents/example.ts", 'import service = require("../workspace/worktrees");', "types"],
  ["main/workspace/example.ts", 'import { helper } from "../agents/command-path";', "entry"],
  ["main/wiring/example.ts", 'import { helper } from "../workspace/internal";', "entry"],
  [
    "main/workspace/example.ts",
    'import type { Wiring } from "../wiring/application-wiring";',
    "wiring",
  ],
  ["main/profile.ts", 'import "./wiring/application";', "wiring"],
  ["main/main.ts", 'import "./wiring/workspace";', "entry"],
  ["renderer/board/example.tsx", 'import { secret } from "../data/queries";', "edge"],
  ["renderer/board/example.tsx", 'export * from "../terminal/internal";', "entry"],
  ["renderer/board/example.tsx", 'import("../terminal/internal");', "entry"],
  ["renderer/board/example.tsx", 'require("../terminal/internal");', "entry"],
  ["renderer/board/example.tsx", 'import menu = require("../terminal/internal");', "entry"],
  ["renderer/board/example.tsx", 'type Menu = import("../terminal/internal").Menu;', "entry"],
  ["renderer/board/example.tsx", 'import "../new-area/internal";', "unknown"],
  ["renderer/new-area/example.tsx", "export {};", "unknown"],
  ["renderer/app.tsx", 'import "./board/private";', "entry"],
];

const aliasInvalid: [string, string][] = [
  ['import("#workspace");', "types"],
  ['import type { WorktreeService } from "#internal";', "entry"],
  ['export * from "#missing";', "unresolved"],
  ['import "#missing-file";', "unresolved"],
  ['import "#blocked";', "unresolved"],
  ['import "#agents";', "unresolved"],
  ['import "#twostars";', "unresolved"],
  ['require("#patterns/worktrees");', "types"],
  ['import("#conditional");', "types"],
];

new RuleTester().run("area-boundaries", areaBoundaries, {
  valid: areaValid
    .map(([file, code]) => ({ filename: resolve("src", file), code }))
    .concat([
      { filename: aliasFile, code: 'import "#allowed";' },
      { filename: aliasFile, code: 'import type { WorktreeService } from "#workspace";' },
    ]),
  invalid: areaInvalid
    .map(([file, code, messageId]) => ({
      filename: resolve("src", file),
      code,
      errors: [{ messageId }],
    }))
    .concat(
      aliasInvalid.map(([code, messageId]) => ({
        filename: aliasFile,
        code,
        errors: [{ messageId }],
      })),
    ),
});

test("area policy accepts removals and narrowing without changing the historical ceiling", () => {
  expect(
    validateAreaPolicy({
      main: {
        agents: { publicModules: ["agents.ts"], imports: { control: "type" } },
        control: { publicModules: [], imports: {} },
      },
    }),
  ).toEqual([]);
  expect(validateAreaPolicy(areaPolicy)).toEqual([]);
});

test("area policy rejects a new public module, area and process", () => {
  expect(
    validateAreaPolicy({ main: { agents: { publicModules: ["internal.ts"], imports: {} } } }),
  ).toEqual(["new public module main/agents/internal.ts"]);
  expect(validateAreaPolicy({ main: { feature: { publicModules: [], imports: {} } } })).toEqual([
    "new area main/feature",
  ]);
  expect(validateAreaPolicy({ preload: {} })).toEqual(["undeclared process preload"]);
});

test("area policy rejects a new reciprocal edge and a runtime widening", () => {
  expect(
    validateAreaPolicy({
      main: {
        agents: { publicModules: [], imports: { terminals: "value", workspace: "value" } },
        terminals: { publicModules: [], imports: { agents: "value" } },
        workspace: { publicModules: [], imports: {} },
      },
    }),
  ).toEqual([
    "new or widened edge main/agents -> main/workspace",
    "new or widened edge main/terminals -> main/agents",
  ]);
});

test("area policy rejects dangling edges when removing an area", () => {
  expect(
    validateAreaPolicy({
      main: {
        agents: { publicModules: [], imports: { workspace: "type" } },
      },
    }),
  ).toEqual(["edge targets undeclared area main/workspace"]);
});
