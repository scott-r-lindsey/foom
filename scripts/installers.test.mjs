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

for (const scenario of ["busy then success", "always busy", "non-busy failure"]) {
  test(`DMG creation: ${scenario}`, { skip: process.platform === "win32" }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "foom-dmg-retry-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const logs = [];
    t.mock.method(console, "info", (message) => logs.push(message));
    const waits = [];
    const errors = [];
    let attempts = 0;
    let copies = 0;
    let staging;
    let output;
    const result = new MakerDMG().make(
      {
        dir: root,
        makeDir: join(root, "make"),
        appName: "Foom",
        packageJSON: { version: "0.1.0" },
        targetArch: "arm64",
      },
      (command, args, options) => {
        if (command === "ditto") {
          copies += 1;
          return;
        }
        assert.equal(command, "hdiutil");
        assert.equal(options.encoding, "buffer");
        staging = args[args.indexOf("-srcfolder") + 1];
        output = args.at(-1);
        assert.equal(existsSync(output), false, "partial image removed before retry");
        attempts += 1;
        writeFileSync(output, "partial image");
        if (scenario === "busy then success" && attempts === 2)
          return { stdout: Buffer.from("created image\n"), stderr: Buffer.from("diagnostic\n") };
        const message = scenario === "non-busy failure" ? "Permission denied" : "Resource busy";
        const error = Object.assign(new Error(`last hdiutil error ${attempts}`), {
          status: 1,
          stdout: Buffer.from(scenario === "busy then success" ? message : "progress\n"),
          stderr: Buffer.from(scenario === "busy then success" ? "" : message),
        });
        errors.push(error);
        throw error;
      },
      async (delay) => {
        waits.push(delay);
      },
    );
    if (scenario === "busy then success") {
      assert.deepEqual(await result, [output]);
      assert.equal(attempts, 2);
      assert.deepEqual(waits, [1000]);
    } else {
      await assert.rejects(result, (error) => error === errors.at(-1));
      assert.equal(attempts, scenario === "always busy" ? 5 : 1);
      assert.deepEqual(waits, scenario === "always busy" ? [1000, 2000, 3000, 4000] : []);
    }
    assert.equal(copies, 1);
    assert.equal(existsSync(staging), false);
    assert.equal(logs.length, attempts);
    for (const [index, log] of logs.entries()) {
      assert.match(log, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] hdiutil create /);
      assert.ok(
        log.includes(
          `attempt ${index + 1}/5, exit status ${index === 1 && scenario === "busy then success" ? 0 : 1}`,
        ),
      );
    }
  });
}

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
