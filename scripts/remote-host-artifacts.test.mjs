import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkoutRevision,
  hostPlatforms,
  packageRemoteHosts,
  writeHostManifest,
  digest,
} from "./remote-host-artifacts.mjs";

test("catalog packaging validates all native manifests and both hashes before shipping compressed payloads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "host-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const output = join(root, "output");
  const revision = "a".repeat(40);
  for (const target of hostPlatforms) {
    const directory = join(source, target);
    await mkdir(directory, { recursive: true });
    const [platform, arch] = target.split("-");
    await writeFile(join(directory, "foom-host"), Buffer.from("fixture SEA"));
    await writeHostManifest(directory, { version: "0.1.0", platform, arch, source: revision });
  }
  await packageRemoteHosts(source, output, "0.1.0", revision);
  for (const target of hostPlatforms) {
    const manifest = JSON.parse(await readFile(join(output, target, "manifest.json")));
    assert.equal(manifest.sha256, digest(Buffer.from("fixture SEA")));
    await assert.rejects(readFile(join(output, target, "foom-host")), /ENOENT/);
  }
  const path = join(source, "linux-x64", "manifest.json");
  const original = JSON.parse(await readFile(path));
  for (const patch of [
    null,
    { version: "0.2.0" },
    { platform: "win32" },
    { protocol: 1 },
    { source: "b".repeat(40) },
    { source: "invalid" },
    { source: "development" },
    { source: undefined },
    { size: 0 },
    { gzipSize: 1 },
    { gzipSha256: "b".repeat(64) },
    { size: 5 },
    { size: 200 },
    { sha256: "b".repeat(64) },
  ]) {
    await writeFile(path, JSON.stringify(patch === null ? null : { ...original, ...patch }));
    await assert.rejects(packageRemoteHosts(source, output, "0.1.0", revision));
  }
  await writeFile(path, JSON.stringify(original));
  await assert.rejects(packageRemoteHosts(source, output, "0.2.0", revision), /version/);
  await assert.rejects(packageRemoteHosts(source, output, "0.1.0"), /expected source/);
  // Every entry agrees, but the entire catalog is stale at the same app version.
  await assert.rejects(
    packageRemoteHosts(source, output, "0.1.0", "b".repeat(40)),
    /revision mismatch/,
  );
  // A later entry from another checkout cannot hide behind the first entry.
  const later = join(source, "darwin-arm64", "manifest.json");
  const laterManifest = JSON.parse(await readFile(later));
  await writeFile(later, JSON.stringify({ ...laterManifest, source: "b".repeat(40) }));
  await assert.rejects(packageRemoteHosts(source, output, "0.1.0", revision), /revision mismatch/);
  await writeFile(later, JSON.stringify(laterManifest));
  await writeFile(join(source, "linux-x64", "foom-host.gz"), "corrupted");
  await assert.rejects(packageRemoteHosts(source, output, "0.1.0", revision));
  await rm(join(source, "darwin-arm64"), { recursive: true });
  await assert.rejects(packageRemoteHosts(source, output, "0.1.0", revision));
});

test("checkout identity uses git argv and rejects non-revisions", () => {
  assert.equal(
    checkoutRevision("/fixture", (command, args, options) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      assert.deepEqual(options, { cwd: "/fixture", encoding: "utf8" });
      return "a".repeat(40) + "\n";
    }),
    "a".repeat(40),
  );
  assert.throws(() => checkoutRevision("/fixture", () => "development"), /source revision/);
});
