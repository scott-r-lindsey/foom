import { execFile } from "node:child_process";
import { terminalFontFamilies } from "../../shared/terminal-fonts";

// Fixed programs and scripts only. No renderer data enters an argument or script.
const MAC_FONTS = `ObjC.import('AppKit');
var manager = $.NSFontManager.sharedFontManager;
var names = ObjC.deepUnwrap(manager.availableFonts);
names.map(function(name) { var font = $.NSFont.fontWithNameSize(name, 14);
return font && font.isFixedPitch ? ObjC.unwrap(font.familyName) : ''; }).join('\\n');`;
const WINDOWS_FONTS = `Add-Type -AssemblyName PresentationCore
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
foreach ($face in [System.Windows.Media.Fonts]::SystemTypefaces) {
  try {
    $glyph = $null
    if (!$face.TryGetGlyphTypeface([ref]$glyph)) { continue }
    $width = -1.0
    $mono = $true
    foreach ($code in 33..126) {
      if (!$glyph.CharacterToGlyphMap.ContainsKey($code)) { $mono = $false; break }
      $advance = $glyph.AdvanceWidths[$glyph.CharacterToGlyphMap[$code]]
      if ($width -lt 0) { $width = $advance }
      if ($advance -ne $width -or $advance -le 0) { $mono = $false; break }
    }
    if ($mono) { $face.FontFamily.Source }
  } catch { }
}`;

export function fontCommand(
  platform: NodeJS.Platform,
): readonly [string, readonly string[]] | null {
  if (platform === "linux")
    return ["/usr/bin/fc-list", [":spacing=100", "--format=%{family[0]}\\n"]];
  if (platform === "darwin") return ["/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_FONTS]];
  if (platform === "win32")
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-Command", WINDOWS_FONTS]];
  return null;
}

export function parseFontOutput(output: string): string[] {
  return terminalFontFamilies(output.split(/\r?\n/));
}

/** Missing platform tools or enumeration failures leave the bundled default usable. */
export async function listTerminalFonts(): Promise<readonly string[]> {
  const command = fontCommand(process.platform);
  if (!command) return [];
  return new Promise((resolve) => {
    execFile(
      command[0],
      [...command[1]],
      { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        resolve(error ? [] : parseFontOutput(stdout));
      },
    );
  });
}
