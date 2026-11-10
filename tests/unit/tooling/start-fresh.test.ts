import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

// Run the actual launcher with a fixture process adapter: no Electron or real CLI runs.
test("start:fresh passes state isolation and cleans only its temporary profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-fresh-launcher-"));
  try {
    const home = join(root, "home");
    const temporary = join(root, "tmp");
    await mkdir(home);
    await mkdir(temporary);
    const record = join(root, "launch.json");
    const adapter = join(root, "adapter.mjs");
    await writeFile(
      adapter,
      `
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import Module, { syncBuiltinESMExports } from "node:module";
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === "electron") return process.execPath;
  return load.call(this, name, ...args);
};
childProcess.spawn = (binary, args, options) => {
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, runAsNode: options.env.ELECTRON_RUN_AS_NODE ?? null }));
  const child = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => child.emit("exit", 0));
  return child;
};
syncBuiltinESMExports();
`,
    );
    await promisify(execFile)(
      process.execPath,
      ["--import", pathToFileURL(adapter).href, resolve("scripts/start-fresh.mjs")],
      {
        env: {
          ...(process.env["SystemRoot"] ? { SystemRoot: process.env["SystemRoot"] } : {}),
          HOME: home,
          USERPROFILE: home,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    );
    const launch: unknown = JSON.parse(await readFile(record, "utf8"));
    expect(launch).toMatchObject({
      args: [
        resolve(".") + sep,
        expect.stringContaining(`--user-data-dir=${join(temporary, "foom-fresh-")}`),
        "--foom-isolated-state",
      ],
      runAsNode: null,
    });
    // The launcher selected its profile under fixture temp and removed it on exit.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(temporary)).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
