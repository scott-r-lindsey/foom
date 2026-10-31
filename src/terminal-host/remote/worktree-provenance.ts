import { dirname } from "node:path";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { record, keys, remotePath } from "../../shared/remote-agent-protocol";
import { gitOrigin, hostProfile } from "../../shared/registered-hosts";

const suffix = ".foom-owner";
/** Observations bind provenance to the original directories, not just their names. */
async function directoryIdentity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    (info.mode & 0o022n) !== 0n ||
    (await realpath(path)) !== path
  )
    throw new Error("Unsafe worktree directory");
  return JSON.stringify([info.dev, info.ino, info.birthtimeNs].map(String));
}
export async function writeWorktreeProvenance(
  profile: string,
  repository: string,
  path: string,
  origin: string,
): Promise<void> {
  const value = {
    version: 1,
    profile,
    repository,
    path,
    origin,
    repositoryIdentity: await directoryIdentity(repository),
    directoryIdentity: await directoryIdentity(path),
  };
  const file = await open(`${path}${suffix}`, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
}
/** Missing, corrupt, redirected and replaced provenance never confers ownership. */
export async function readWorktreeProvenance(path: string) {
  try {
    const marker = `${path}${suffix}`;
    const before = await lstat(marker);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.nlink !== 1 ||
      before.size > 16384
    )
      return undefined;
    const file = await open(
      marker,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY,
    );
    let value: unknown;
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== before.uid ||
        (info.mode & 0o077) !== 0 ||
        info.nlink !== 1 ||
        info.dev !== before.dev ||
        info.ino !== before.ino ||
        info.size !== before.size
      )
        return undefined;
      const bytes = Buffer.alloc(16385);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 16384) return undefined;
      value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
    if (
      !record(value) ||
      !keys(value, [
        "version",
        "profile",
        "repository",
        "path",
        "origin",
        "repositoryIdentity",
        "directoryIdentity",
      ]) ||
      value["version"] !== 1 ||
      !hostProfile(value["profile"]) ||
      value["path"] !== path ||
      !remotePath(value["repository"]) ||
      !gitOrigin(value["origin"]) ||
      dirname(value["repository"]) !== dirname(path) ||
      value["directoryIdentity"] !== (await directoryIdentity(path)) ||
      value["repositoryIdentity"] !== (await directoryIdentity(value["repository"]))
    )
      return undefined;
    return { profile: value["profile"], repository: value["repository"], origin: value["origin"] };
  } catch {
    return undefined;
  }
}
export const worktreeProvenancePath = (path: string): string => `${path}${suffix}`;
