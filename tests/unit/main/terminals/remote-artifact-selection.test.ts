import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({
  output: "Linux\nx86_64\n",
  failure: false,
  execFile:
    vi.fn<
      (
        file: string,
        args: string[],
        options: unknown,
        callback: (error: Error | null, result: { stdout: string }) => void,
      ) => void
    >(),
}));
vi.mock("node:child_process", () => ({ execFile: mock.execFile }));
import {
  selectHostArtifact,
  sshEnvironment,
} from "../../../../src/main/terminals/remote-bootstrap";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "host-selection-"));
  roots.push(root);
  mock.output = "Linux\nx86_64\n";
  mock.failure = false;
  mock.execFile.mockImplementation((_file, _args, _options, callback) => {
    callback(mock.failure ? new Error("probe failed") : null, { stdout: mock.output });
  });
  const directory = join(root, "linux-x64");
  await mkdir(directory);
  const bytes = Buffer.from("fixture host");
  const compressed = gzipSync(bytes);
  const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const manifest = {
    version: "0.1.0",
    source: "a".repeat(40),
    protocol: 2,
    platform: "linux",
    arch: "x64",
    size: bytes.length,
    sha256: hash(bytes),
    gzipSize: compressed.length,
    gzipSha256: hash(compressed),
  };
  const path = join(directory, "foom-host.gz");
  await writeFile(path, compressed);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  const metadata = join(root, "build-metadata.json");
  await writeFile(metadata, JSON.stringify({ source: manifest.source }));
  return { root, path, metadata, manifest, directory };
}

test("uses bounded SSH discovery and a fixed catalog path, validates version and override platform", async () => {
  const f = await fixture();
  vi.stubEnv("FOOM_CONTROL_TOKEN", "never send");
  vi.stubEnv("SSH_AUTH_SOCK", "/fixture/agent");
  const target = { host: "fixture" };
  expect((await selectHostArtifact(target, "0.1.0", f.root, f.metadata)).platform).toBe("linux");
  expect(mock.execFile).toHaveBeenLastCalledWith(
    "ssh",
    expect.arrayContaining(["--", "fixture", "uname -s; uname -m"]),
    expect.objectContaining({ timeout: 10000, maxBuffer: 256, shell: false }),
    expect.any(Function),
  );
  expect(sshEnvironment()).not.toHaveProperty("FOOM_CONTROL_TOKEN");
  expect(sshEnvironment()).toHaveProperty("SSH_AUTH_SOCK", "/fixture/agent");
  await expect(selectHostArtifact(target, "0.2.0", f.root, f.metadata)).rejects.toThrow("mismatch");
  mock.output = "Darwin\narm64\n";
  await expect(
    selectHostArtifact({ ...target, artifact: f.path }, "0.1.0", f.root, f.metadata),
  ).rejects.toThrow("mismatch");
  await expect(selectHostArtifact(target, "0.1.0", f.root, f.metadata)).rejects.toThrow();
  mock.output = "Linux\nx86_64\nextra";
  await expect(selectHostArtifact(target, "0.1.0", f.root, f.metadata)).rejects.toThrow(
    "Unsupported",
  );
  mock.failure = true;
  await expect(selectHostArtifact(target, "0.1.0", f.root, f.metadata)).rejects.toThrow(
    "probe failed",
  );
  await expect(
    selectHostArtifact({ host: "-oProxyCommand=id" }, "0.1.0", f.root, f.metadata),
  ).rejects.toThrow("host");
});

test("defaults to the bundled catalog and fails closed when it is absent", async () => {
  await fixture();
  await expect(selectHostArtifact({ host: "fixture" }, "missing-version")).rejects.toThrow();
});

test("catalog selection pins same-version hosts to trusted app metadata", async () => {
  const f = await fixture();
  for (const source of [undefined, null, 1, "development", "bad", "b".repeat(40)]) {
    await writeFile(join(f.directory, "manifest.json"), JSON.stringify({ ...f.manifest, source }));
    await expect(
      selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
    ).rejects.toThrow("mismatch");
  }
  // Explicit developer override allows another valid commit, preserving byte/platform checks.
  await expect(
    selectHostArtifact({ host: "fixture", artifact: f.path }, "0.1.0", f.root, f.metadata),
  ).resolves.toHaveProperty("version", "0.1.0");
  await writeFile(join(f.directory, "manifest.json"), JSON.stringify(f.manifest));
  for (const value of [null, {}, { source: 1 }, { source: "development" }]) {
    await writeFile(f.metadata, JSON.stringify(value));
    await expect(
      selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
    ).rejects.toThrow("application source");
  }
  await rm(f.metadata);
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
  ).rejects.toThrow();
});

test("local packages without a catalog refuse remote shells and allow a verified override", async () => {
  const f = await fixture();
  await writeFile(
    f.metadata,
    JSON.stringify({ source: f.manifest.source, remoteHostsAvailable: false }),
  );
  mock.execFile.mockClear();
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
  ).rejects.toThrow("foom-error:remote-host-unavailable");
  expect(mock.execFile).not.toHaveBeenCalled();
  await expect(
    selectHostArtifact({ host: "fixture", artifact: f.path }, "0.1.0", f.root, f.metadata),
  ).resolves.toHaveProperty("version", "0.1.0");
});
