"use strict";

const process = require("node:process");
const { MakerBase } = require("@electron-forge/maker-base");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const console = require("node:console");
const executeFile = promisify(execFile);
const { mkdtempSync, rmSync, symlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");

// Use Apple's native maker: appdmg's dependency chain needs native lifecycle
// scripts and an API-incompatible image-size upgrade to pass the audit gate.
class MakerDMG extends MakerBase {
  name = "dmg";
  defaultPlatforms = ["darwin"];
  isSupportedOnCurrentPlatform() {
    return process.platform === "darwin";
  }
  async make(
    { dir, makeDir, appName, packageJSON, targetArch },
    execute = executeFile,
    sleep = wait,
  ) {
    const output = resolve(
      makeDir,
      "dmg",
      targetArch,
      `${appName}-${packageJSON.version}-${targetArch}.dmg`,
    );
    await this.ensureFile(output);
    const scratch = mkdtempSync(join(tmpdir(), "foom-dmg-"));
    try {
      await execute("ditto", [join(dir, `${appName}.app`), join(scratch, `${appName}.app`)]);
      symlinkSync("/Applications", join(scratch, "Applications"));
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        let failure;
        let stdout;
        let stderr;
        try {
          const result = await execute(
            "hdiutil",
            [
              "create",
              "-volname",
              appName,
              "-srcfolder",
              scratch,
              "-format",
              "ULFO",
              "-ov",
              output,
            ],
            { encoding: "buffer" },
          );
          stdout = result?.stdout;
          stderr = result?.stderr;
        } catch (error) {
          failure = error;
          stdout = error.stdout;
          stderr = error.stderr;
        }
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        console.info(
          `[${new Date().toISOString()}] hdiutil create ${output}: attempt ${attempt}/5, exit status ${failure ? (failure.status ?? failure.code ?? failure.signal ?? "unknown") : 0}`,
        );
        if (!failure) break;
        if (attempt === 5 || !`${stdout ?? ""}\n${stderr ?? ""}`.includes("Resource busy")) {
          throw failure;
        }
        await sleep(attempt * 1000);
        rmSync(output, { force: true });
      }
      return [output];
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
module.exports = MakerDMG;
