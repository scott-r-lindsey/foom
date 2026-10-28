import { windowsAcl } from "./private-file-permissions";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { ControlError, exact, identifier, object } from "../shared/control-validation";

/** An exclusive new file, including an explicit owner on elevated Windows tokens. */
export async function createPrivateFile(path: string): Promise<FileHandle> {
  const file = await open(path, "wx", 0o600);
  try {
    if (process.platform === "win32") await windowsAcl(path, true);
    return file;
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
}

export async function verifyPrivate(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()))
    throw new ControlError("unavailable");
  if (process.platform === "win32") {
    await windowsAcl(path, false);
  } else if (
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (!directory && info.nlink !== 1)
  )
    throw new ControlError("unavailable");
}

/** Read-only migration boundary for old app-profile files, never agent configuration. */
export async function verifyLegacyProfileFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
    throw new ControlError("unavailable");
  if (process.platform === "win32") await windowsAcl(path, false, true);
  else await verifyPrivate(path, false);
}

export async function privateDirectory(parent: string, name = "control"): Promise<string> {
  // Names are single validated components, never arbitrary relative paths.
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u.test(name)) throw new ControlError("unavailable");
  // The profile is app-owned; reject redirected control roots and existing insecure entries.
  const directory = join(await realpath(parent), name);
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  if (created && process.platform === "win32") await windowsAcl(directory, true);
  await verifyPrivate(directory, true);
  return directory;
}

export async function atomicPrivate(
  directory: string,
  name: string,
  value: unknown,
): Promise<void> {
  await verifyPrivate(directory, true);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const file = await createPrivateFile(temporary);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();
    await rename(temporary, join(directory, name));
    if (process.platform !== "win32") {
      const parent = await open(directory, constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
}

export async function readDiscovery(
  directory: string,
): Promise<{ version: 1; endpoint: string; instanceId: string }> {
  await verifyPrivate(directory, true);
  const path = join(directory, "discovery.json");
  await verifyPrivate(path, false);
  const expected = await lstat(path);
  const file = await open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = await file.stat();
    if (opened.dev !== expected.dev || opened.ino !== expected.ino || !opened.isFile())
      throw new ControlError("unavailable");
    if (
      process.platform !== "win32" &&
      (opened.uid !== process.getuid?.() || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1)
    )
      throw new ControlError("unavailable");
    if (opened.size > 4096) throw new ControlError("invalid_request");
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new ControlError("invalid_request");
    await verifyPrivate(directory, true);
    await verifyPrivate(path, false);
    const current = await lstat(path);
    if (current.dev !== opened.dev || current.ino !== opened.ino)
      throw new ControlError("unavailable");
    const input: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)),
    );
    const value = object(input);
    exact(value, ["version", "endpoint", "instanceId"]);
    if (value["version"] !== 1 || typeof value["endpoint"] !== "string")
      throw new ControlError("invalid_request");
    const url = new URL(value["endpoint"]);
    if (
      value["endpoint"] !== url.href ||
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/control/v1"
    )
      throw new ControlError("invalid_request");
    return { version: 1, endpoint: url.href, instanceId: identifier(value["instanceId"]) };
  } finally {
    await file.close();
  }
}
