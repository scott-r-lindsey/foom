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
    const request = join(directory, "request.json");
    const resultFile = join(directory, "result.json");
    const setupHash = digest(setupFile);
    const setup =
      setupHash === null ? [] : ["--require", `./${relative(process.cwd(), setupFile)}`];
    const pending = files.map((file) => resolve(file));
    const discovered = new Map();
    const fingerprints = new Map([
      [setupFile, setupHash],
      [worker, digest(worker)],
    ]);
    for (let offset = 0; offset < pending.length; ) {
      rmSync(resultFile, { force: true });
      writeFileSync(request, JSON.stringify({ files: pending.slice(offset), resultFile }));
      const result = spawnSync(
        process.execPath,
        ["--expose-internals", ...setup, "--test", "--test-concurrency=1", ...args, worker],
        { env: { ...env, ELECTRON_REGISTRATION_REQUEST: request }, stdio: "ignore" },
      );
      if (result.status !== 0) break;
      const batch = JSON.parse(readFileSync(resultFile, "utf8"));
      if (batch.entries.length === 0) break;
      for (const [file, entry] of batch.entries) discovered.set(file, entry);
      for (const [file, hash] of batch.fingerprints) fingerprints.set(file, hash);
      offset += batch.entries.length;
    }
    const inventory = new Map(files.map((file) => [file, discovered.get(resolve(file))]));
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
