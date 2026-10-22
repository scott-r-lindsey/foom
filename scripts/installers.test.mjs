import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  rmSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import MakerDMG from "./maker-dmg.cjs";
import { notarizationSession, signDmg } from "./macos-sign.mjs";

test("native DMG contains the exact app and Applications link; cleanup runs on failure", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "foom-dmg-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "Foom.app"));
  writeFileSync(join(root, "Foom.app", "sealed"), "signed app bytes");
  const maker = new MakerDMG();
  for (const failure of [false, true]) {
    let staging;
    const result = maker.make(
      {
        dir: root,
        makeDir: join(root, "make"),
        appName: "Foom",
        packageJSON: { version: "0.1.0" },
        targetArch: "arm64",
      },
      (command, args) => {
        if (command === "ditto") {
          cpSync(args[0], args[1], { recursive: true });
          return;
        }
        assert.equal(command, "hdiutil");
        staging = args[args.indexOf("-srcfolder") + 1];
        assert.equal(readFileSync(join(staging, "Foom.app/sealed"), "utf8"), "signed app bytes");
        assert.equal(readlinkSync(join(staging, "Applications")), "/Applications");
        assert.ok(args.includes("ULFO"));
        if (failure) throw new Error("fixture failure");
      },
    );
    if (failure) await assert.rejects(result, /fixture failure/);
    else assert.match((await result)[0], /Foom-0\.1\.0-arm64\.dmg$/);
    assert.equal(existsSync(staging), false);
  }
});

test("DMG notarization rejects non-Accepted submissions before stapling", async () => {
  for (const status of ["Accepted", "Invalid", "Rejected"]) {
    const calls = [];
    const action = () =>
      signDmg(
        "signed.dmg",
        {
          identity: "fixture",
          keychain: "temporary",
          appleApiKey: "fixture.p8",
          appleApiKeyId: "id",
          appleApiIssuer: "issuer",
        },
        (command, args) => {
          calls.push([command, args]);
          return JSON.stringify({ id: "fixture-dmg", status });
        },
        notarizationSession({ log: () => {} }),
      );
    if (status === "Accepted") {
      await action();
      assert.ok(calls.some(([command, args]) => command === "xcrun" && args[1] === "validate"));
      assert.equal(calls.at(-1)[0], "spctl");
    } else {
      await assert.rejects(action, new RegExp(status));
      assert.ok(!calls.some(([, args]) => args[0] === "stapler"));
    }
  }
});

test("installer smoke uses extracted payloads and never performs system installation", () => {
  const smoke = readFileSync("scripts/installer-smoke.mjs", "utf8");
  assert.match(smoke, /FOOM_PACKAGED_ROOT: root/);
  assert.match(smoke, /--extract/);
  assert.match(smoke, /-qlp/);
  assert.match(smoke, /-readonly/);
  assert.doesNotMatch(smoke, /sudo|dpkg -i|rpm -i|Start-Process/);
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /xvfb-run -a pnpm run test:installers/);
  assert.match(workflow, /run: pnpm run test:installers/);
});
