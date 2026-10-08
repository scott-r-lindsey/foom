import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { FileHandle } from "node:fs/promises";
import { ControlError, exact, identifier, object } from "./control-validation";

const execute = promisify(execFile);
// Fixed .NET calls avoid PowerShell module autoloading (PSModulePath can come from pwsh 7).
// Paths are environment data. Protect the DACL and grant only the current SID.
const aclScript = `
$ErrorActionPreference='Stop'
$p=$env:FOOM_PRIVATE_PATH
$attributes=[System.IO.File]::GetAttributes($p)
$directory=($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'reparse point' }
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$a=if ($directory) { [System.IO.Directory]::GetAccessControl($p) } else { [System.IO.File]::GetAccessControl($p) }
if ($env:FOOM_PRIVATE_CREATE -eq '1') {
  $a.SetAccessRuleProtection($true,$false)
  foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { [void]$a.RemoveAccessRuleSpecific($r) }
  $a.SetOwner($sid)
  $r=if ($directory) { [System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow') } else { [System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow') }
  $a.AddAccessRule($r)
  if ($directory) { [System.IO.Directory]::SetAccessControl($p,$a) } else { [System.IO.File]::SetAccessControl($p,$a) }
  $a=if ($directory) { [System.IO.Directory]::GetAccessControl($p) } else { [System.IO.File]::GetAccessControl($p) }
}
if (!$a.AreAccessRulesProtected) { throw 'inherited access' }
if ($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
$rules=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
foreach($r in $rules) {
  if ($r.IdentityReference.Value -ne $sid.Value) { throw 'access' }
}
if ($rules.Count -eq 0) { throw 'access' }
`;

async function windowsAcl(path: string, create: boolean): Promise<void> {
  await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", aclScript], {
    env: { ...process.env, FOOM_PRIVATE_PATH: path, FOOM_PRIVATE_CREATE: create ? "1" : "0" },
    timeout: 5000,
  });
}

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

export async function privateDirectory(parent: string): Promise<string> {
  // The profile is app-owned; reject redirected control roots and existing insecure entries.
  const directory = join(await realpath(parent), "control");
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
