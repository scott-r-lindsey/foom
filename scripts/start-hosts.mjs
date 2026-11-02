import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkoutRevision, hostPlatforms, verifyHostArtifact } from "./remote-host-artifacts.mjs";

const repository = "scott-r-lindsey/foom";

/** Prepare only: importing this function never launches the development app. */
export async function prepareHosts(root, execute = execFileSync, log = console.info) {
  const cache = join(root, ".cache/remote-hosts");
  let temporary;
  try {
    const revision = checkoutRevision(root, execute);
    const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const verify = async (directory) => {
      for (const target of hostPlatforms)
        await verifyHostArtifact(join(directory, target), target, version, revision);
    };
    try {
      await verify(cache);
      log(`Remote hosts: using verified cache for ${revision}.`);
      return cache;
    } catch {
      // A stale or incomplete cache is preserved until its replacement verifies.
    }
    const gh = (args) =>
      execute("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const runs = JSON.parse(
      gh([
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        "ci.yml",
        "--branch",
        "main",
        "--event",
        "push",
        "--commit",
        revision,
        "--status",
        "success",
        "--limit",
        "1",
        "--json",
        "databaseId",
      ]),
    );
    if (!Array.isArray(runs) || runs.length === 0)
      throw new Error(
        `no successful main push CI run for ${revision} (local commit or CI pending)`,
      );
    const id = runs[0]?.databaseId;
    assert.ok(Number.isSafeInteger(id) && id > 0, "Invalid CI run ID");
    await mkdir(join(root, ".cache"), { recursive: true });
    temporary = await mkdtemp(join(root, ".cache/start-hosts-"));
    const catalog = join(temporary, "catalog");
    for (const target of hostPlatforms)
      gh([
        "run",
        "download",
        String(id),
        "--repo",
        repository,
        "--name",
        `remote-host-${target}`,
        "--dir",
        join(catalog, target),
      ]);
    await verify(catalog);
    const backup = join(temporary, "previous");
    let moved = false;
    try {
      await rename(cache, backup);
      moved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(catalog, cache);
    } catch (error) {
      if (moved) await rename(backup, cache);
      throw error;
    }
    log(`Remote hosts: verified all four targets from CI run ${id} for ${revision}.`);
  } catch (error) {
    const reason =
      error.code === "ENOENT" && error.path === "gh"
        ? "gh is missing; install GitHub CLI and authenticate with gh auth login"
        : error.message;
    log(
      `Remote hosts: continuing without a catalog (${String(reason).replace(/\s+/g, " ").trim()}).`,
    );
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
  return cache;
}

export async function startHosts(
  root,
  args,
  { execute = execFileSync, launch = spawn, log = console.info } = {},
) {
  const cache = await prepareHosts(root, execute, log);
  const child = launch("pnpm", ["start", ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, FOOM_REMOTE_HOST_ARTIFACTS: cache },
  });
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await startHosts(
    fileURLToPath(new URL("../", import.meta.url)),
    process.argv.slice(2),
  );
}
