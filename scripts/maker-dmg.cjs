const process = require("node:process");
const { MakerBase } = require("@electron-forge/maker-base");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, symlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

// Use Apple's native maker: appdmg's dependency chain needs native lifecycle
// scripts and an API-incompatible image-size upgrade to pass the audit gate.
class MakerDMG extends MakerBase {
  name = "dmg";
  defaultPlatforms = ["darwin"];
  isSupportedOnCurrentPlatform() {
    return process.platform === "darwin";
  }
  async make({ dir, makeDir, appName, packageJSON, targetArch }, execute = execFileSync) {
    const output = resolve(
      makeDir,
      "dmg",
      targetArch,
      `${appName}-${packageJSON.version}-${targetArch}.dmg`,
    );
    await this.ensureFile(output);
    const scratch = mkdtempSync(join(tmpdir(), "foom-dmg-"));
    try {
      execute("ditto", [join(dir, `${appName}.app`), join(scratch, `${appName}.app`)]);
      symlinkSync("/Applications", join(scratch, "Applications"));
      execute(
        "hdiutil",
        ["create", "-volname", appName, "-srcfolder", scratch, "-format", "ULFO", "-ov", output],
        { stdio: "inherit" },
      );
      return [output];
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
module.exports = MakerDMG;
