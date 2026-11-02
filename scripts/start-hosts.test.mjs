import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitSync } from "../tests/helpers/git.js";
import { hostPlatforms, verifyHostArtifact, writeHostManifest } from "./remote-host-artifacts.mjs";
import { prepareHosts, startHosts } from "./start-hosts.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "start-hosts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  gitSync(["init", "--quiet"], { cwd: root });
  gitSync(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  const revision = gitSync(["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const gh = join(root, "gh.cjs");
  await writeFile(
    gh,
    `
const { appendFileSync, cpSync, readFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(join(__dirname, 'calls'), JSON.stringify(args) + '\\n');
const mode = readFileSync(join(__dirname, 'mode'), 'utf8');
if (mode === 'auth') { console.error('gh auth login required'); process.exit(1); }
if (args[1] === 'list') { console.log(mode === 'none' ? '[]' : '[{"databaseId":123}]'); }
else {
  const target = args[args.indexOf('--name') + 1].replace('remote-host-', '');
  if (mode === 'download' && target === 'darwin-arm64') { console.error('artifact expired'); process.exit(1); }
  const output = args[args.indexOf('--dir') + 1];
  mkdirSync(output, { recursive: true });
  cpSync(join(__dirname, 'artifacts', target), output, { recursive: true });
}
`,
  );
  await writeFile(join(root, "mode"), "success");
  const execute = (command, args, options) => {
    if (command === "git") return gitSync(args, options);
    assert.equal(command, "gh");
    return execFileSync(process.execPath, [gh, ...args], options);
  };
  const messages = [];
  const log = (message) => messages.push(message);
  const cache = join(root, ".cache/remote-hosts");
  async function catalog(directory, source = revision) {
    for (const target of hostPlatforms) {
      const output = join(directory, target);
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "foom-host"), `fixture ${target} ${source}`);
      const [platform, arch] = target.split("-");
      await writeHostManifest(output, { version: "0.1.0", platform, arch, source });
      await rm(join(output, "foom-host"));
    }
  }
  await catalog(join(root, "artifacts"));
  return { root, revision, execute, messages, log, cache, catalog };
}

test("downloads the exact successful main push run, verifies all four hosts and reuses the cache", async (t) => {
  const f = await fixture(t);
  await f.catalog(f.cache, "b".repeat(40));
  assert.equal(await prepareHosts(f.root, f.execute, f.log), f.cache);
  for (const target of hostPlatforms)
    await verifyHostArtifact(join(f.cache, target), target, "0.1.0", f.revision);
  const calls = (await readFile(join(f.root, "calls"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls[0], [
    "run",
    "list",
    "--repo",
    "scott-r-lindsey/foom",
    "--workflow",
    "ci.yml",
    "--branch",
    "main",
    "--event",
    "push",
    "--commit",
    f.revision,
    "--status",
    "success",
    "--limit",
    "1",
    "--json",
    "databaseId",
  ]);
  assert.equal(calls.length, 5);
  for (const [index, target] of hostPlatforms.entries()) {
    assert.deepEqual(calls[index + 1].slice(0, 8), [
      "run",
      "download",
      "123",
      "--repo",
      "scott-r-lindsey/foom",
      "--name",
      `remote-host-${target}`,
      "--dir",
    ]);
  }
  const cachedExecute = (command, args, options) => {
    assert.equal(command, "git");
    return f.execute(command, args, options);
  };
  await prepareHosts(f.root, cachedExecute, f.log);
  assert.match(f.messages.at(-1), /using verified cache/);
  assert.deepEqual(await readdir(join(f.root, ".cache")), ["remote-hosts"]);
});

for (const mode of [
  "none",
  "auth",
  "download",
  "hash",
  "partial",
  "version",
  "revision",
  "missing-gh",
]) {
  test(`${mode}: continues with one line and preserves the previous catalog`, async (t) => {
    const f = await fixture(t);
    await f.catalog(f.cache, "b".repeat(40));
    const previous = await readFile(join(f.cache, "linux-x64", "manifest.json"), "utf8");
    await writeFile(join(f.root, "mode"), mode);
    const manifestPath = join(f.root, "artifacts/darwin-arm64/manifest.json");
    if (["hash", "version", "revision"].includes(mode)) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest[mode === "hash" ? "sha256" : mode === "revision" ? "source" : "version"] =
        mode === "hash" ? "0".repeat(64) : mode === "revision" ? "c".repeat(40) : "0.2.0";
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    if (mode === "partial") await rm(manifestPath);
    const execute = (command, args, options) => {
      if (mode === "missing-gh" && command === "gh")
        throw Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT", path: "gh" });
      return f.execute(command, args, options);
    };
    assert.equal(await prepareHosts(f.root, execute, f.log), f.cache);
    assert.equal(f.messages.length, 1);
    assert.match(f.messages[0], /continuing without a catalog/);
    assert.ok(!f.messages[0].includes("\n"));
    assert.match(
      f.messages[0],
      mode === "none"
        ? /no successful main push/
        : mode === "auth"
          ? /gh auth login/
          : mode === "missing-gh"
            ? /gh is missing/
            : mode === "download"
              ? /artifact expired/
              : mode === "partial"
                ? /ENOENT/
                : /mismatch/,
    );
    assert.equal(await readFile(join(f.cache, "linux-x64", "manifest.json"), "utf8"), previous);
    for (const target of hostPlatforms)
      await verifyHostArtifact(join(f.cache, target), target, "0.1.0", "b".repeat(40));
    assert.deepEqual(await readdir(join(f.root, ".cache")), ["remote-hosts"]);
  });
}

test("normal startup forwards arguments, artifact environment and exit status even without a run", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "mode"), "none");
  const args = ["--", "--user-data-dir=/fixture profile", "literal;$(never)"];
  const code = await startHosts(f.root, args, {
    execute: f.execute,
    log: f.log,
    launch(command, forwarded, options) {
      assert.equal(command, "pnpm");
      assert.deepEqual(forwarded, ["start", ...args]);
      assert.equal(options.cwd, f.root);
      assert.equal(options.stdio, "inherit");
      assert.equal(options.env.FOOM_REMOTE_HOST_ARTIFACTS, f.cache);
      assert.equal(options.env.PATH, process.env.PATH);
      return spawn(process.execPath, ["-e", "process.exit(17)"], { stdio: "ignore" });
    },
  });
  assert.equal(code, 17);
});
