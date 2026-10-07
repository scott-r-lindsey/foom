import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { ControlError, exact, identifier, object } from "./validation";

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
  $r=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $a.AddAccessRule($r)
  [System.IO.Directory]::SetAccessControl($p,$a)
  $a=[System.IO.Directory]::GetAccessControl($p)
}
if ($directory -and !$a.AreAccessRulesProtected) { throw 'inherited directory access' }
if ($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
$rules=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
foreach($r in $rules) {
  if ($r.IdentityReference.Value -ne $sid.Value) { throw 'access' }
}
if ($rules.Count -eq 0) { throw 'access' }
`;

export async function verifyPrivate(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()))
    throw new ControlError("unavailable");
  if (process.platform === "win32") {
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", aclScript], {
      env: { ...process.env, FOOM_PRIVATE_PATH: path, FOOM_PRIVATE_CREATE: "0" },
      timeout: 5000,
    });
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
  if (created && process.platform === "win32")
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", aclScript], {
      env: { ...process.env, FOOM_PRIVATE_PATH: directory, FOOM_PRIVATE_CREATE: "1" },
      timeout: 5000,
    });
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
  const file = await open(temporary, "wx", 0o600);
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
  const file = await open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    if ((await file.stat()).size > 4096) throw new ControlError("invalid_request");
    const input: unknown = JSON.parse(await file.readFile("utf8"));
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
