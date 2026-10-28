import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";
import { join } from "node:path";
import { extractFile } from "@electron/asar";
import { macBundleVersion } from "./nightly.mjs";

// Forge calls this after packaging and before signing. Packager's appVersion
// rewrites package.json too, so it cannot represent our native-only version.
export function setMacBundleVersions(app, execute = execFileSync) {
  const manifest = JSON.parse(
    extractFile(join(app, "Contents/Resources/app.asar"), "package.json"),
  );
  const version = macBundleVersion(manifest);
  const frameworks = join(app, "Contents/Frameworks");
  const plists = [
    join(app, "Contents/Info.plist"),
    ...globSync("**/*.app/Contents/Info.plist", { cwd: frameworks }).map((plist) =>
      join(frameworks, plist),
    ),
  ];
  for (const plist of plists)
    for (const key of ["CFBundleShortVersionString", "CFBundleVersion"])
      execute("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${version}`, plist]);
}
