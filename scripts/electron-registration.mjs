import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./electron-registration-worker.cjs", import.meta.url));
const setupFile = fileURLToPath(new URL("../tests/helpers/setup.js", import.meta.url));
const cache = new Map();

function digest(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

export function discoverRegistrations(files, { shard, patterns = [] } = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  if (shard === undefined) delete env.FOOM_ELECTRON_SHARD;
  else env.FOOM_ELECTRON_SHARD = shard;
  const args = patterns.map((pattern) => `--test-name-pattern=${pattern}`);
  const key = createHash("sha256")
    .update(JSON.stringify([process.cwd(), env, args, files]))
    .digest("hex");
  const previous = cache.get(key);
  if (previous?.fingerprints.every(([file, hash]) => digest(file) === hash))
    return previous.inventory;

  const directory = mkdtempSync(join(tmpdir(), "foom-electron-registration-"));
  try {
    const setupHash = digest(setupFile);
    const setup =
      setupHash === null ? [] : ["--require", `./${relative(process.cwd(), setupFile)}`];
    const fingerprints = new Map([
      [setupFile, setupHash],
      [worker, digest(worker)],
    ]);
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
        const discovered = JSON.parse(readFileSync(result, "utf8"));
        inventory.set(file, discovered.entry);
        for (const [path, hash] of discovered.fingerprints) fingerprints.set(path, hash);
      } catch {
        inventory.set(file, undefined);
      }
    }
    if ([...inventory.values()].every((entry) => entry?.registrations)) {
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      cache.set(key, { inventory, fingerprints: [...fingerprints] });
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
