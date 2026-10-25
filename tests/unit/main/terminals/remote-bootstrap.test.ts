import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import {
  bootstrapArguments,
  hostArtifact,
  remoteSpikeTarget,
  remotePlatform,
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
    source: "a".repeat(40),
    platform: "linux",
    arch: "x64",
    protocol: 2,
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
    upload: gzipSync(f.bytes, { level: 1 }),
    platform: "linux",
    arch: "x64",
    version: "0.1.0",
    sha256: f.manifest.sha256,
  });
  await expect(hostArtifact("relative")).rejects.toThrow("absolute");
  for (const patch of [
    { version: "../bad" },
    { source: undefined },
    { source: 1 },
    { source: "development" },
    { source: "bad" },
    { sha256: "a".repeat(64) },
    { size: 0 },
    { platform: "win32" },
    { arch: "bad" },
    { protocol: 1 },
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
  expect(
    bootstrapArguments(
      "cloud",
      "0.1.0-nightly.20261025+abcdef0",
      hash,
      1,
      21,
      "darwin",
      "arm64",
    ).at(-1),
  ).toContain("0.1.0-nightly.20261025+abcdef0");
  const args = bootstrapArguments("user@cloud", "0.1.0-spike.1", hash, 123, 42, "linux", "x64");
  expect(args.slice(0, 14)).toEqual([
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ConnectTimeout=10",
    "--",
    "user@cloud",
    "sh",
  ]);
  expect(args.at(-1)).toContain("head -c 42");
  expect(args.at(-1)).toContain("sha256sum");
  for (const host of ["-oProxyCommand=id", "cloud;id", "cloud\n-oProxyCommand=id"])
    expect(() => bootstrapArguments(host, "0.1.0", hash, 123, 42, "linux", "x64")).toThrow();
  for (const [version, sha, size] of [
    ["../x", hash, 1],
    ["0.1.0", "bad", 1],
    ["0.1.0", hash, 0],
    ["0.1.0", hash, 201 * 1024 * 1024],
  ] as const)
    expect(() => bootstrapArguments("cloud", version, sha, size, 42, "linux", "x64")).toThrow();
  expect(remoteSpikeTarget([])).toBeUndefined();
  expect(
    remoteSpikeTarget(["--remote-shell-spike=cloud", "--remote-host-artifact=/tmp/host"]),
  ).toEqual({ host: "cloud", artifact: "/tmp/host" });
  for (const args of [
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

test("maps only exact supported uname results", () => {
  for (const [output, platform, arch] of [
    ["Linux\nx86_64\n", "linux", "x64"],
    ["Linux\naarch64\n", "linux", "arm64"],
    ["Darwin\nx86_64\n", "darwin", "x64"],
    ["Darwin\narm64\n", "darwin", "arm64"],
  ])
    expect(remotePlatform(output ?? "")).toEqual({ platform, arch });
  for (const output of [
    "Linux\nx86_64",
    "Linux\narm64\n",
    "Darwin\naarch64\n",
    "Windows\nx86_64\n",
    "Linux\nx86_64\nextra",
    "Linux\n../x\n",
    "Linux\nx86_64;id\n",
  ])
    expect(() => remotePlatform(output)).toThrow("Unsupported");
  expect(remoteSpikeTarget(["--remote-shell-spike=cloud"])).toEqual({ host: "cloud" });
  expect(() =>
    bootstrapArguments("cloud", "0.1.0", "a".repeat(64), 1, 0, "linux", "x64"),
  ).toThrow();
  expect(() =>
    bootstrapArguments("cloud", "0.1.0", "a".repeat(64), 1, 1, "win32", "x64"),
  ).toThrow();
  expect(() =>
    bootstrapArguments("cloud", "0.1.0", "a".repeat(64), 1, 1, "linux", "ia32"),
  ).toThrow();
});

test("compressed catalogs validate both compressed and expanded bytes", async () => {
  const f = await fixture();
  const upload = gzipSync(f.bytes);
  const path = join(f.root, "foom-host.gz");
  const manifest = {
    ...f.manifest,
    gzipSize: upload.length,
    gzipSha256: createHash("sha256").update(upload).digest("hex"),
  };
  await writeFile(path, upload);
  await writeFile(join(f.root, "manifest.json"), JSON.stringify(manifest));
  const artifact = await hostArtifact(path, f.manifest.source);
  await expect(hostArtifact(path, "b".repeat(40))).rejects.toThrow("mismatch");
  expect(gunzipSync(artifact.upload)).toEqual(f.bytes);
  for (const patch of [
    { gzipSize: undefined },
    { gzipSha256: undefined },
    { gzipSize: 1 },
    { gzipSha256: "a".repeat(64) },
    { sha256: "a".repeat(64) },
  ]) {
    await writeFile(join(f.root, "manifest.json"), JSON.stringify({ ...manifest, ...patch }));
    await expect(hostArtifact(path)).rejects.toThrow("mismatch");
  }
  const empty = gzipSync(Buffer.alloc(0));
  await writeFile(path, empty);
  await writeFile(
    join(f.root, "manifest.json"),
    JSON.stringify({
      ...manifest,
      size: 0,
      sha256: createHash("sha256").update("").digest("hex"),
      gzipSize: empty.length,
      gzipSha256: createHash("sha256").update(empty).digest("hex"),
    }),
  );
  await expect(hostArtifact(path)).rejects.toThrow("mismatch");
  await writeFile(path, "corrupt gzip");
  await expect(hostArtifact(path)).rejects.toThrow();
});
