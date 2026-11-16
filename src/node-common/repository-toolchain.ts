import { readOwnedFile } from "./owned-files";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, basename, join, posix } from "node:path";
import { setupArtifact, setupCatalog } from "../shared/repository-setup-catalog";
import type { SetupPlatform } from "../shared/repository-setup.d";
import { privateDirectory, verifyPrivate } from "./private-files";
import { setupCatalogDigest } from "./repository-setup-digest";

/** Archive inspection is independent of extraction; no tar program or lifecycle script runs. */
export function setupArchive(
  bytes: Uint8Array,
  tool: "node" | "pnpm",
): ReadonlyMap<string, Uint8Array> {
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let offset = 0;
  let members = 0;
  let longName: string | undefined;
  const field = (start: number, length: number) =>
    new TextDecoder("utf-8", { fatal: true })
      .decode(tar.subarray(start, start + length))
      .split("\0")[0] ?? "";
  while (offset + 512 <= tar.length) {
    if (tar.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    if (++members > 20000) throw new Error("Toolchain archive refused");
    const checksum = field(offset + 148, 8).trim();
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (tar[offset + i] ?? 0);
    const sizeText = field(offset + 124, 12).trim();
    if (!/^[0-7]+$/u.test(sizeText) || !/^[0-7]+$/u.test(checksum) || parseInt(checksum, 8) !== sum)
      throw new Error("Toolchain archive refused");
    const size = parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size > 200 * 1024 * 1024 || offset + 512 + size > tar.length)
      throw new Error("Toolchain archive refused");
    const type = field(offset + 156, 1);
    if (type === "L") {
      if (longName !== undefined || size < 2 || size > 4096)
        throw new Error("Toolchain archive long name refused");
      const content = tar.subarray(offset + 512, offset + 512 + size);
      if (content.at(-1) !== 0 || content.subarray(0, -1).includes(0))
        throw new Error("Toolchain archive long name refused");
      longName = new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, -1));
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }
    const prefix = field(offset + 345, 155);
    const name = (longName ?? `${prefix ? `${prefix}/` : ""}${field(offset, 100)}`).replace(
      /\/$/u,
      "",
    );
    longName = undefined;
    const parts = name.split("/");
    const root = tool === "node" ? `node-v${setupCatalog.node.version}-` : "package";
    if (
      !name ||
      name.includes("\\") ||
      /[\p{Cc}]/u.test(name) ||
      parts.some((part) => !part || part === "." || part === "..") ||
      (tool === "node" ? !parts[0]?.startsWith(root) : parts[0] !== root) ||
      seen.has(name)
    )
      throw new Error("Toolchain archive refused");
    seen.add(name);
    if (type === "1" || type === "2") {
      const link = field(offset + 157, 100);
      const resolved = type === "1" ? posix.normalize(link) : posix.join(posix.dirname(name), link);
      if (
        posix.isAbsolute(link) ||
        !resolved.startsWith(`${parts[0] ?? ""}/`) ||
        link.includes("\\")
      )
        throw new Error("Toolchain archive link refused");
      // Node's npm links are not needed; never materialize archive-provided links.
    } else if (type !== "5" && type !== "0" && type !== "")
      throw new Error("Toolchain archive member refused");
    else if (
      type !== "5" &&
      ((tool === "node" && parts.slice(1).join("/") === "bin/node") ||
        (tool === "pnpm" && parts.length > 1))
    )
      files.set(
        parts.slice(1).join("/"),
        Uint8Array.from(tar.subarray(offset + 512, offset + 512 + size)),
      );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (
    longName !== undefined ||
    (tool === "node" && !files.has("bin/node")) ||
    (tool === "pnpm" && !files.has("bin/pnpm.cjs"))
  )
    throw new Error("Toolchain archive incomplete");
  return files;
}

/** No redirects, credentials, moving releases or checkout configuration. */
export async function downloadSetupArtifact(
  tool: "node" | "pnpm",
  platform: SetupPlatform,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Uint8Array> {
  const artifact = setupArtifact(tool, platform);
  if (!artifact) throw new Error("Toolchain unavailable");
  const response = await request(artifact.url, { redirect: "error", signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Toolchain download failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 128 * 1024 * 1024) throw new Error("Toolchain download too large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  if (createHash(artifact.algorithm).update(bytes).digest(artifact.encoding) !== artifact.digest)
    throw new Error("Toolchain integrity failed");
  return bytes;
}

export function setupToolchainDirectory(prefix: string, tool: "node" | "pnpm"): string {
  return join(prefix, `${tool}-${setupCatalog[tool].version}-${setupCatalogDigest.slice(0, 16)}`);
}
export async function selectedToolchainBins(
  prefix: string,
  tools: readonly ("node" | "pnpm")[],
): Promise<string[]> {
  const bins: string[] = [];
  for (const tool of tools) {
    const directory = setupToolchainDirectory(prefix, tool);
    try {
      await verifyPrivate(prefix, true);
      await verifyPrivate(directory, true);
      const receipt: unknown = JSON.parse(
        await readOwnedFile(join(directory, "receipt.json"), 256),
      );
      if (receipt !== setupCatalogDigest || (await realpath(directory)) !== directory) continue;
      const bin = join(directory, "bin");
      const info = await lstat(bin);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) continue;
      bins.push(bin);
    } catch {
      /* An incomplete or absent private publication is never selected. */
    }
  }
  return bins;
}

/** Publish privately, only after a complete integrity-verified, non-executing extraction. */
export async function installSetupToolchain(
  prefix: string,
  tool: "node" | "pnpm",
  platform: SetupPlatform,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<void> {
  if (!platform.nodeAbi || !setupArtifact(tool, platform))
    throw new Error("Toolchain ABI unsupported");
  await privateDirectory(dirname(prefix), basename(prefix));
  const destination = setupToolchainDirectory(prefix, tool);
  if ((await selectedToolchainBins(prefix, [tool])).length) return;
  const staging = await mkdtemp(join(prefix, ".staging-"));
  try {
    const bytes = await downloadSetupArtifact(tool, platform, signal, request);
    const files = setupArchive(bytes, tool);
    signal.throwIfAborted();
    for (const [path, content] of files) {
      signal.throwIfAborted();
      const target = join(staging, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, {
        flag: "wx",
        mode: path === "bin/node" || path === "bin/pnpm.cjs" ? 0o700 : 0o600,
      });
    }
    if (tool === "pnpm") await symlink("pnpm.cjs", join(staging, "bin", "pnpm"));
    await writeFile(join(staging, "receipt.json"), JSON.stringify(setupCatalogDigest), {
      flag: "wx",
      mode: 0o600,
    });
    signal.throwIfAborted();
    await verifyPrivate(prefix, true);
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
