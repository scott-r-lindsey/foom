import { execFile } from "node:child_process";
import { lstat, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { ControlError, exact, object } from "../node-common/control-validation";

const execute = promisify(execFile);
const windowsPath = `
$ErrorActionPreference='Stop'
# Load the Windows PowerShell built-in explicitly; inherited pwsh module paths are untrusted.
Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')
Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FoomEnvironment {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message,
    UIntPtr parameter, string value, uint flags, uint timeout, out UIntPtr result);
}
'@
$p=$env:FOOM_CLI_DIRECTORY
$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $old=$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $parts=@($old.Split(';'))
  $found=@($parts | Where-Object { [string]::Equals($_,$p,[StringComparison]::OrdinalIgnoreCase) })
  if ($env:FOOM_CLI_REMOVE -eq '1') {
    if ($found.Count -ne 1) { throw 'changed path' }
    $new=(@($parts | Where-Object { ![string]::Equals($_,$p,[StringComparison]::OrdinalIgnoreCase) }) -join ';')
  } else {
    if ($found.Count -ne 0) { throw 'already present' }
    $new=if ($old) { $old+';'+$p } else { $p }
  }
  $kind=if ($k.GetValueNames() -contains 'Path') { $k.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  $k.SetValue('Path',$new,$kind)
} finally { $k.Dispose() }
[UIntPtr]$result=[UIntPtr]::Zero
[void][FoomEnvironment]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,2000,[ref]$result)
`;

/** Explicit CLI setup only. No shell startup files, global agent config, or overwrites. */
export async function installCli(
  executable: string,
  directory: string,
  remove: boolean,
  env: NodeJS.ProcessEnv,
  platform = process.platform,
): Promise<string> {
  if (!isAbsolute(directory) || /[;\p{Cc}\p{Cf}]/u.test(directory))
    throw new ControlError("invalid_request");
  const bin = await realpath(directory);
  const name = platform === "win32" ? "foom.exe" : "foom";
  const destination = join(bin, name);
  const record = join(bin, ".foom-cli-install.json");
  if (remove) {
    const info = await lstat(record);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
      throw new ControlError("conflict");
    const value = object(JSON.parse(await readFile(record, "utf8")));
    exact(value, ["version", "target"]);
    if (
      value["version"] !== 1 ||
      typeof value["target"] !== "string" ||
      !isAbsolute(value["target"])
    )
      throw new ControlError("conflict");
    if (platform === "win32") {
      if (basename(value["target"]) !== name) throw new ControlError("conflict");
      await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsPath], {
        env: { ...env, FOOM_CLI_DIRECTORY: dirname(value["target"]), FOOM_CLI_REMOVE: "1" },
        timeout: 10000,
        windowsHide: true,
      });
    } else {
      if (
        !(await lstat(destination)).isSymbolicLink() ||
        (await readlink(destination)) !== value["target"]
      )
        throw new ControlError("conflict");
      await rm(destination);
    }
    await rm(record);
    return "CLI PATH setup removed. Open a new shell.";
  }
  const target = await realpath(executable);
  if (!(await lstat(target)).isFile()) throw new ControlError("unavailable");
  if (platform === "win32" && dirname(target) !== bin) throw new ControlError("invalid_request");
  for (const path of (env["PATH"] ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!path) continue;
    for (const suffix of platform === "win32" ? [".exe", ".cmd", ".bat", ".com"] : [""]) {
      try {
        await lstat(join(path, `foom${suffix}`));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      throw new ControlError("conflict");
    }
  }
  await writeFile(record, JSON.stringify({ version: 1, target }), { flag: "wx", mode: 0o600 });
  try {
    if (platform === "win32")
      await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsPath], {
        env: { ...env, FOOM_CLI_DIRECTORY: bin, FOOM_CLI_REMOVE: "0" },
        timeout: 10000,
        windowsHide: true,
      });
    else await symlink(target, destination);
  } catch (error) {
    await rm(record);
    throw error;
  }
  return platform === "win32"
    ? "CLI directory added to your user PATH. Open a new shell."
    : `CLI link installed in ${bin}. Add this directory to PATH if needed; shell startup files were not edited.`;
}
