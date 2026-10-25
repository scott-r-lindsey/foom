import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  hostPlatforms,
  packageRemoteHosts,
  signRemoteHost,
  writeHostManifest,
  digest,
} from "./remote-host-artifacts.mjs";

test("host signing is always ad-hoc with runtime entitlements and strict verification", () => {
  const calls = [];
  signRemoteHost("/fixture/foom-host", (command, args) => calls.push([command, args]));
  assert.deepEqual(calls, [
    [
      "codesign",
      [
        "--force",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--timestamp=none",
        "--entitlements",
        resolve("scripts/entitlements-adhoc.plist"),
        "/fixture/foom-host",
      ],
    ],
    ["codesign", ["--verify", "--strict", "/fixture/foom-host"]],
  ]);
  assert.throws(
    () =>
      signRemoteHost("/fixture/foom-host", () => {
        throw new Error("Apple fixture failure");
      }),
    /Apple fixture failure/,
  );
});

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
    { protocol: 2 },
    { source: "b".repeat(40) },
    { source: "invalid" },
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
  await packageRemoteHosts(source, output, "0.1.0");
  await writeFile(join(source, "linux-x64", "foom-host.gz"), "corrupted");
  await assert.rejects(packageRemoteHosts(source, output, "0.1.0", revision));
  await rm(join(source, "darwin-arm64"), { recursive: true });
  await assert.rejects(packageRemoteHosts(source, output, "0.1.0", revision));
});
