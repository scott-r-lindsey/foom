import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, globSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Extract to scratch only. Never install packages, run setup.exe, or touch
// /Applications, the user's profile, system package databases or registry.
const kinds =
  process.platform === "linux"
    ? ["deb", "rpm"]
    : process.platform === "darwin"
      ? ["dmg"]
      : ["nupkg"];
for (const kind of kinds) {
  const files = globSync(`out/make/**/*.${kind}`).filter(
    (file) => kind !== "nupkg" || file.endsWith("-full.nupkg"),
  );
  assert.equal(files.length, 1, `Expected one ${kind} installer`);
  const file = resolve(files[0]);
  const scratch = mkdtempSync(join(tmpdir(), `foom-${kind}-`));
  let root;
  try {
    if (kind === "deb") {
      execFileSync("dpkg-deb", ["--contents", file], { stdio: "inherit" });
      execFileSync("dpkg-deb", ["--extract", file, scratch]);
      root = join(scratch, "usr/lib/foom");
    } else if (kind === "rpm") {
      execFileSync("rpm", ["-qlp", file], { stdio: "inherit" });
      const cpio = execFileSync("rpm2cpio", [file], { maxBuffer: 1024 * 1024 * 1024 });
      execFileSync("cpio", ["-id", "--quiet", "--no-absolute-filenames"], {
        cwd: scratch,
        input: cpio,
      });
      root = join(scratch, "usr/lib/foom");
    } else if (kind === "dmg") {
      const mount = join(scratch, "mount");
      execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, file]);
      try {
        execFileSync("ditto", [join(mount, "Foom.app"), join(scratch, "Foom.app")]);
      } finally {
        execFileSync("hdiutil", ["detach", mount]);
      }
      root = scratch;
    } else {
      execFileSync("tar.exe", ["-xf", file, "-C", scratch]);
      root = join(scratch, "lib/net45");
    }
    if (process.platform === "linux") {
      assert.equal(readlinkSync(join(scratch, "usr/bin/foom")), "../lib/foom/Foom");
      assert.match(
        readFileSync(join(scratch, "usr/share/applications/foom.desktop"), "utf8"),
        /^Exec=\/usr\/lib\/foom\/Foom %U$/m,
      );
    }
    execFileSync(process.execPath, ["scripts/electron-tests.mjs", "--packaged"], {
      stdio: "inherit",
      env: { ...process.env, FOOM_PACKAGED_ROOT: root },
    });
  } finally {
    for (const suffix of ["xml", "json"])
      for (const file of globSync(`test-results/packaged*.${suffix}`).filter(
        (file) => !/-(deb|rpm|dmg|nupkg)\.(xml|json)$/.test(file),
      ))
        cpSync(file, file.replace(`.${suffix}`, `-${kind}.${suffix}`));
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}
