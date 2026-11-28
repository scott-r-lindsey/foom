import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./electron-registration-worker.cjs", import.meta.url));
const setupFile = fileURLToPath(new URL("../tests/helpers/setup.js", import.meta.url));

export function discoverRegistrations(files, { shard, patterns = [] } = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  if (shard === undefined) delete env.FOOM_ELECTRON_SHARD;
  else env.FOOM_ELECTRON_SHARD = shard;
  const args = patterns.map((pattern) => `--test-name-pattern=${pattern}`);

  const directory = mkdtempSync(join(tmpdir(), "foom-electron-registration-"));
  try {
    const setup = existsSync(setupFile)
      ? ["--require", `./${relative(process.cwd(), setupFile)}`]
      : [];
    const bridges = files.map((file, index) => {
      const entry = join(directory, `${index}.cjs`);
      const result = join(directory, `${index}.json`);
      writeFileSync(
        entry,
        `require(${JSON.stringify(worker)})(${JSON.stringify(resolve(file))}, ${JSON.stringify(result)});\n`,
      );
      return { file, entry, result };
    });
    spawnSync(
      process.execPath,
      [
        "--expose-internals",
        ...setup,
        "--test",
        // Discovery has no windows or test bodies, so workers can register in parallel.
        "--test-concurrency=4",
        ...args,
        ...bridges.map(({ entry }) => entry),
      ],
      { env, stdio: "ignore" },
    );

    const inventory = new Map();
    for (const { file, result } of bridges) {
      try {
        inventory.set(file, JSON.parse(readFileSync(result, "utf8")));
      } catch {
        inventory.set(file, undefined);
      }
    }
    return inventory;
  } catch {
    return new Map();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function discoverPlannedTests(files) {
  const inventory = discoverRegistrations(files);
  const names = new Map();
  for (const file of files) {
    const entry = inventory.get(file);
    if (!entry?.registrations)
      throw new Error(
        `Cannot inventory Electron suite ${file}: ${entry?.error ?? "discovery incomplete"}`,
      );
    for (const { name, sharded } of entry.registrations) {
      if (!sharded) continue;
      if (names.has(name))
        throw new Error(`Duplicate planned Electron test name in ${file}: ${name}`);
      names.set(name, file);
    }
  }
  return names;
}
