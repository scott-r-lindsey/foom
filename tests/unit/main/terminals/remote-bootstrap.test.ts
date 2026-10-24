import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import {
  bootstrapArguments,
  hostArtifact,
  remoteSpikeTarget,
} from "../../../../src/main/terminals/remote-bootstrap";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "host-artifact-"));
  roots.push(root);
  const bytes = Buffer.from("fake executable");
  const manifest = {
    version: "0.1.0",
    platform: "linux",
    arch: "x64",
    protocol: 1,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await writeFile(join(root, "foom-host"), bytes);
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, bytes, manifest, path: join(root, "foom-host") };
}
test("checks pinned artifact bytes, bounded metadata and supported target", async () => {
  const f = await fixture();
  expect(await hostArtifact(f.path)).toEqual({
    bytes: f.bytes,
    version: "0.1.0",
    sha256: f.manifest.sha256,
  });
  await expect(hostArtifact("relative")).rejects.toThrow("absolute");
  for (const patch of [
    { version: "../bad" },
    { sha256: "a".repeat(64) },
    { size: 0 },
    { platform: "win32" },
    { arch: "bad" },
    { protocol: 2 },
  ]) {
    await writeFile(join(f.root, "manifest.json"), JSON.stringify({ ...f.manifest, ...patch }));
    await expect(hostArtifact(f.path)).rejects.toThrow("mismatch");
  }
  for (const bad of [
    null,
    {},
    { version: 1 },
    { version: "0.1.0" },
    { ...f.manifest, sha256: null },
  ]) {
    await writeFile(join(f.root, "manifest.json"), JSON.stringify(bad));
    await expect(hostArtifact(f.path)).rejects.toThrow();
  }
  await writeFile(join(f.root, "manifest.json"), " ".repeat(4097));
  await expect(hostArtifact(f.path)).rejects.toThrow("artifact");
  await writeFile(join(f.root, "empty"), "");
  await expect(hostArtifact(join(f.root, "empty"))).rejects.toThrow();
  await mkdir(join(f.root, "directory"));
  await expect(hostArtifact(join(f.root, "directory"))).rejects.toThrow();
  if (process.platform !== "win32") {
    await symlink(f.path, join(f.root, "link"));
    await expect(hostArtifact(join(f.root, "link"))).rejects.toThrow();
  }
});
test("argv is explicit and option-injection attempts never reach ssh", () => {
  const hash = "a".repeat(64);
  const args = bootstrapArguments("user@cloud", "0.1.0-spike.1", hash, 123);
  expect(args.slice(0, 10)).toEqual([
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ConnectTimeout=10",
    "--",
    "user@cloud",
    "sh",
  ]);
  expect(args.at(-1)).toContain("head -c 123");
  expect(args.at(-1)).toContain("sha256sum");
  for (const host of ["-oProxyCommand=id", "cloud;id", "cloud\n-oProxyCommand=id"])
    expect(() => bootstrapArguments(host, "0.1.0", hash, 123)).toThrow();
  for (const [version, sha, size] of [
    ["../x", hash, 1],
    ["0.1.0", "bad", 1],
    ["0.1.0", hash, 0],
    ["0.1.0", hash, 201 * 1024 * 1024],
  ] as const)
    expect(() => bootstrapArguments("cloud", version, sha, size)).toThrow();
  expect(remoteSpikeTarget([])).toBeUndefined();
  expect(
    remoteSpikeTarget(["--remote-shell-spike=cloud", "--remote-host-artifact=/tmp/host"]),
  ).toEqual({ host: "cloud", artifact: "/tmp/host" });
  for (const args of [
    ["--remote-shell-spike=cloud"],
    ["--remote-host-artifact=/tmp/host"],
    ["--remote-shell-spike=-oProxyCommand=id", "--remote-host-artifact=/tmp/host"],
    [
      "--remote-shell-spike=cloud",
      "--remote-shell-spike=cloud",
      "--remote-host-artifact=/tmp/host",
    ],
    ["--remote-shell-spike=cloud", "--remote-host-artifact=relative"],
  ])
    expect(() => remoteSpikeTarget(args)).toThrow();
});

test.skipIf(process.platform === "win32")(
  "FIFO artifacts are rejected without waiting for a writer",
  async () => {
    const f = await fixture();
    const fifo = join(f.root, "fifo");
    execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo], { env: { PATH: "/nonexistent" } });
    await expect(hostArtifact(fifo)).rejects.toThrow("Invalid host artifact");
  },
);
