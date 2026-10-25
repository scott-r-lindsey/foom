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
    protocol: 1,
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
  return { root, path };
}

test("uses bounded SSH discovery and a fixed catalog path, validates version and override platform", async () => {
  const f = await fixture();
  vi.stubEnv("FOOM_CONTROL_TOKEN", "never send");
  vi.stubEnv("SSH_AUTH_SOCK", "/fixture/agent");
  const target = { host: "fixture" };
  expect((await selectHostArtifact(target, "0.1.0", f.root)).platform).toBe("linux");
  expect(mock.execFile).toHaveBeenLastCalledWith(
    "ssh",
    expect.arrayContaining(["--", "fixture", "uname -s; uname -m"]),
    expect.objectContaining({ timeout: 10000, maxBuffer: 256, shell: false }),
    expect.any(Function),
  );
  expect(sshEnvironment()).not.toHaveProperty("FOOM_CONTROL_TOKEN");
  expect(sshEnvironment()).toHaveProperty("SSH_AUTH_SOCK", "/fixture/agent");
  await expect(selectHostArtifact(target, "0.2.0", f.root)).rejects.toThrow("mismatch");
  mock.output = "Darwin\narm64\n";
  await expect(
    selectHostArtifact({ ...target, artifact: f.path }, "0.1.0", f.root),
  ).rejects.toThrow("mismatch");
  await expect(selectHostArtifact(target, "0.1.0", f.root)).rejects.toThrow();
  mock.output = "Linux\nx86_64\nextra";
  await expect(selectHostArtifact(target, "0.1.0", f.root)).rejects.toThrow("Unsupported");
  mock.failure = true;
  await expect(selectHostArtifact(target, "0.1.0", f.root)).rejects.toThrow("probe failed");
  await expect(selectHostArtifact({ host: "-oProxyCommand=id" }, "0.1.0", f.root)).rejects.toThrow(
    "host",
  );
});

test("defaults to the bundled catalog and fails closed when it is absent", async () => {
  await fixture();
  await expect(selectHostArtifact({ host: "fixture" }, "missing-version")).rejects.toThrow();
});
