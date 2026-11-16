import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setupArchive,
  downloadSetupArtifact,
  installSetupToolchain,
  selectedToolchainBins,
  setupToolchainDirectory,
} from "../../../src/node-common/repository-toolchain";
import * as catalog from "../../../src/shared/repository-setup-catalog";
import type { SetupPlatform } from "../../../src/shared/repository-setup.d";
const platform: SetupPlatform = { os: "linux", arch: "x64", distro: "debian", nodeAbi: true };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "repository-toolchain-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
function tar(
  entries: readonly {
    name: string;
    bytes?: string;
    type?: string;
    link?: string;
    prefix?: string;
  }[],
): Uint8Array {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000700\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156);
    header.write(entry.link ?? "", 157, 100);
    header.write("ustar\0", 257);
    header.write(entry.prefix ?? "", 345, 155);
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
const nodeName = `node-v${catalog.setupCatalog.node.version}-linux-x64/bin/node`;
const bytes = () => tar([{ name: nodeName, bytes: "fixture binary; never executed" }]);
function pin(data: Uint8Array) {
  vi.spyOn(catalog, "setupArtifact").mockReturnValue({
    url: "https://fixture.invalid/node.tar.gz",
    algorithm: "sha256",
    digest: createHash("sha256").update(data).digest("hex"),
    encoding: "hex",
  });
}
const response = (data: Uint8Array) => new Response(Buffer.from(data));
describe("catalog-pinned toolchain archives", () => {
  it("retains only the Node executable and never materializes archive links", () => {
    const archive = tar([
      { name: "node-v24.17.0-linux-x64/", type: "5" },
      { name: nodeName, bytes: "fixture" },
      { name: "node-v24.17.0-linux-x64/bin/npm", type: "2", link: "../lib/npm.js" },
    ]);
    expect([...setupArchive(archive, "node").keys()]).toEqual(["bin/node"]);
    expect([
      ...setupArchive(
        tar([
          { name: "package/bin/pnpm.cjs", bytes: "fixture" },
          { name: "dist/pnpm.cjs", prefix: "package", bytes: "module" },
        ]),
        "pnpm",
      ).keys(),
    ]).toEqual(["bin/pnpm.cjs", "dist/pnpm.cjs"]);
  });
  it.each([
    { name: "../escape", bytes: "bad" },
    { name: "/escape", bytes: "bad" },
    { name: "package/../escape", bytes: "bad" },
    { name: "package/a\\b", bytes: "bad" },
    { name: "package/link", type: "2", link: "/outside" },
    { name: "package/link", type: "2", link: "../../outside" },
    { name: "package/link", type: "1", link: "elsewhere" },
    { name: "package/device", type: "3" },
  ])("refuses unsafe member %#", (entry) => {
    expect(() => setupArchive(tar([entry]), "pnpm")).toThrow();
  });
  it("rejects duplicate, corrupt, empty and incomplete archives", () => {
    expect(() =>
      setupArchive(
        tar([
          { name: nodeName, bytes: "a" },
          { name: nodeName, bytes: "b" },
        ]),
        "node",
      ),
    ).toThrow();
    expect(() => setupArchive(tar([]), "node")).toThrow();
    expect(() => setupArchive(tar([{ name: "package/other", bytes: "x" }]), "pnpm")).toThrow();
    expect(() => setupArchive(Buffer.from("not gzip"), "node")).toThrow();
  });
  it("verifies fixture integrity and disallows redirects and failed responses", async () => {
    const data = bytes();
    pin(data);
    const request = vi.fn<typeof fetch>(() => Promise.resolve(response(data)));
    expect(
      await downloadSetupArtifact("node", platform, new AbortController().signal, request),
    ).toEqual(Buffer.from(data));
    expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
    request.mockResolvedValueOnce(new Response("corrupt"));
    await expect(
      downloadSetupArtifact("node", platform, new AbortController().signal, request),
    ).rejects.toThrow("integrity");
    request.mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(
      downloadSetupArtifact("node", platform, new AbortController().signal, request),
    ).rejects.toThrow("download");
    vi.restoreAllMocks();
    await expect(
      downloadSetupArtifact(
        "node",
        { ...platform, arch: "unsupported" },
        new AbortController().signal,
        request,
      ),
    ).rejects.toThrow("unavailable");
  });
  it("atomically publishes to a private prefix and skips existing complete publications", async () => {
    const prefix = join(root, "toolchains");
    const data = bytes();
    pin(data);
    const request = vi.fn<typeof fetch>(() => Promise.resolve(response(data)));
    expect(await selectedToolchainBins(prefix, ["node"])).toEqual([]);
    await installSetupToolchain(prefix, "node", platform, new AbortController().signal, request);
    const directory = setupToolchainDirectory(prefix, "node");
    expect(await readFile(join(directory, "bin", "node"), "utf8")).toContain("fixture binary");
    expect(await selectedToolchainBins(prefix, ["node"])).toEqual([join(directory, "bin")]);
    await installSetupToolchain(prefix, "node", platform, new AbortController().signal, request);
    expect(request).toHaveBeenCalledTimes(1);
    await writeFile(join(directory, "receipt.json"), '"wrong"');
    expect(await selectedToolchainBins(prefix, ["node"])).toEqual([]);
    await expect(
      installSetupToolchain(
        prefix,
        "node",
        { ...platform, nodeAbi: false },
        new AbortController().signal,
        request,
      ),
    ).rejects.toThrow("ABI");
  });
  it("publishes pnpm without lifecycle execution and removes failed staging", async () => {
    const prefix = join(root, "toolchains");
    const data = tar([{ name: "package/bin/pnpm.cjs", bytes: "#!/usr/bin/env node\nfixture" }]);
    pin(data);
    const request = vi.fn<typeof fetch>(() => Promise.resolve(response(data)));
    await installSetupToolchain(prefix, "pnpm", platform, new AbortController().signal, request);
    expect(await selectedToolchainBins(prefix, ["pnpm"])).toHaveLength(1);
    const node = setupToolchainDirectory(prefix, "node");
    request.mockResolvedValueOnce(new Response("corrupt"));
    await expect(
      installSetupToolchain(prefix, "node", platform, new AbortController().signal, request),
    ).rejects.toThrow();
    await expect(readFile(join(node, "receipt.json"))).rejects.toThrow();
    const bins = join(setupToolchainDirectory(prefix, "pnpm"), "bin");
    if (process.platform !== "win32") {
      await chmod(bins, 0o777);
      expect(await selectedToolchainBins(prefix, ["pnpm"])).toEqual([]);
    }
    await mkdir(join(root, "unexpected"));
  });
});

it("handles bounded GNU long names without permitting traversal or dangling metadata", () => {
  const long = `node-v24.17.0-linux-x64/include/${"long/".repeat(25)}header.h`;
  const metadata = { name: "././@LongLink", type: "L", bytes: `${long}\0` };
  expect([
    ...setupArchive(
      tar([{ name: nodeName, bytes: "fixture" }, metadata, { name: "truncated", bytes: "header" }]),
      "node",
    ).keys(),
  ]).toEqual(["bin/node"]);
  for (const entries of [
    [metadata],
    [metadata, metadata],
    [
      { ...metadata, bytes: "../escape\0" },
      { name: "truncated", bytes: "bad" },
    ],
    [{ ...metadata, bytes: "missing terminator" }],
    [{ ...metadata, bytes: "a\0b\0" }],
    [{ ...metadata, bytes: "x".repeat(4097) }],
  ])
    expect(() => setupArchive(tar(entries), "node")).toThrow();
});
