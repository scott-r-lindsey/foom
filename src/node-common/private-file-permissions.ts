import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
if (!$a.AreAccessRulesProtected -and $env:FOOM_PRIVATE_PROFILE -ne '1') { throw 'inherited access' }
$allowed=@($sid.Value)
# Legacy profile files may inherit the OS's SYSTEM and local Administrators rules.
# Other users/groups are never accepted, even for read access.
if ($env:FOOM_PRIVATE_PROFILE -eq '1') { $allowed += 'S-1-5-18'; $allowed += 'S-1-5-32-544' }
if ($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'owner' }
$rules=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
foreach($r in $rules) {
  if ($r.IdentityReference.Value -notin $allowed) { throw 'access' }
}
if ($rules.Count -eq 0) { throw 'access' }
`;

export async function windowsAcl(path: string, create: boolean, profile = false): Promise<void> {
  await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", aclScript], {
    env: {
      ...process.env,
      FOOM_PRIVATE_PATH: path,
      FOOM_PRIVATE_CREATE: create ? "1" : "0",
      FOOM_PRIVATE_PROFILE: profile ? "1" : "0",
    },
    timeout: 5000,
  });
}
