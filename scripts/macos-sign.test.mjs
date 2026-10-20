import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
  entitlementFor,
  notarizeApp,
  run,
  signApp,
  signingArgs,
  signingOrder,
} from "./macos-sign.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "foom-sign-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "Foom.app");
  const paths = [
    "Contents/MacOS/Foom",
    "Contents/Frameworks/Foom Helper (Plugin).app/Contents/MacOS/Foom Helper (Plugin)",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    "Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node",
    "Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper",
    "Contents/Resources/app.asar.unpacked/build/console/foom",
    "Contents/Resources/app.asar.unpacked/build/observers/observer",
  ];
  for (const name of paths) {
    mkdirSync(dirname(join(app, name)), { recursive: true });
    writeFileSync(join(app, name), Buffer.from("cffaedfe00000000", "hex"));
  }
  writeFileSync(join(app, "Contents/Resources/app.asar"), "not executable");
  return { root, app, paths };
}

test("signs every Mach-O inside out, ignores symlink aliases and grants only runtime entitlements", {
  skip: process.platform === "win32",
}, async (t) => {
  const { root, app, paths } = fixture(t);
  symlinkSync("A", join(app, "Contents/Frameworks/Electron Framework.framework/Versions/Current"));
  const order = await signingOrder(app);
  assert.equal(order.at(-1), app);
  for (const path of paths) assert.ok(order.includes(join(app, path)), path);
  for (const target of order) {
    for (const parent of order.filter((other) => target.startsWith(`${other}/`))) {
      assert.ok(order.indexOf(target) < order.indexOf(parent));
    }
  }
  assert.equal(order.length, paths.length + 3);
  const calls = [];
  await signApp(
    app,
    { identity: "Developer ID Application: Fixture (TEAM)", keychain: "/temporary/keychain" },
    (command, args) => calls.push([command, args]),
    async () => ({ fuses: "unchanged", archive: "unchanged" }),
  );
  assert.equal(calls.length, order.length + 1);
  assert.deepEqual(calls.at(-1), [
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", app],
  ]);
  for (const [, args] of calls.slice(0, -1)) {
    assert.ok(!args.includes("--deep"));
    assert.ok(args.includes("--timestamp"));
    assert.ok(args.includes("runtime"));
  }
  assert.equal(entitlementFor(app, join(app, paths[4]), false), undefined);
  assert.equal(entitlementFor(app, join(app, paths[3]), false), undefined);
  assert.equal(entitlementFor(app, join(app, paths[6]), false), undefined);
  assert.ok(entitlementFor(app, join(app, paths[5]), false).endsWith("entitlements-runtime.plist"));
  assert.ok(entitlementFor(app, join(app, paths[1]), false).endsWith("entitlements-runtime.plist"));
  assert.ok(entitlementFor(app, app, true).endsWith("entitlements-adhoc.plist"));
  assert.ok(signingArgs(app, { identity: "-" }).includes("--timestamp=none"));
  await assert.rejects(
    signApp(
      app,
      { identity: "-" },
      () => {},
      (() => {
        let count = 0;
        return async () => count++;
      })(),
    ),
    /Signing changed/,
  );
  await assert.rejects(
    signApp(
      app,
      { identity: "-" },
      () => {
        throw new Error("fixture signing failure");
      },
      async () => ({}),
    ),
    /fixture signing failure/,
  );
  assert.ok(
    !readFileSync(resolve("scripts/entitlements-runtime.plist"), "utf8").includes(
      "disable-library-validation",
    ),
  );
  assert.ok(root);
});

test("fixture codesign and xcrun exercise notarize API-key arguments, stapling and strict final assessment offline", {
  skip: process.platform === "win32",
}, async (t) => {
  const { root, app } = fixture(t);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "calls.jsonl");
  for (const name of ["codesign", "xcrun", "ditto", "spctl"]) {
    const file = join(bin, name);
    writeFileSync(
      file,
      `#!${process.execPath}\nconst {appendFileSync}=require('node:fs');\nconst args=process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)},JSON.stringify([${JSON.stringify(name)},args])+'\\n');\nif (${JSON.stringify(name)} === 'xcrun' && args[0] === 'notarytool' && args[1] === 'submit') console.log(JSON.stringify({id:'fixture-id',status:'Accepted'}));\nif (${JSON.stringify(name)} === 'spctl') console.log(process.env.FIXTURE_ASSESSMENT || 'source=Notarized Developer ID');\n`,
    );
    chmodSync(file, 0o755);
  }
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.PATH = bin; // No system tools or Apple services can be reached.
  process.env.DEBUG = "";
  const credentials = {
    appleApiKey: join(root, "fixture.p8"),
    appleApiKeyId: "FIXTUREKEY",
    appleApiIssuer: "fixture-issuer",
  };
  await notarizeApp(app, credentials);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const submit = calls.find(([name, args]) => name === "xcrun" && args[1] === "submit");
  assert.deepEqual(submit[1].slice(3), [
    "--key",
    credentials.appleApiKey,
    "--key-id",
    credentials.appleApiKeyId,
    "--issuer",
    credentials.appleApiIssuer,
    "--wait",
    "--output-format",
    "json",
  ]);
  assert.ok(
    calls.some(([name, args]) => name === "xcrun" && args[0] === "stapler" && args[1] === "staple"),
  );
  assert.deepEqual(calls.at(-1), ["xcrun", ["stapler", "validate", app]]);
  process.env.FIXTURE_ASSESSMENT = "source=Developer ID";
  await assert.rejects(notarizeApp(app, credentials), /Notarized Developer ID/);
  assert.throws(() => run("missing-command", ["secret-value"]), {
    message: "missing-command failed",
  });
});

test("Release secrets are confined to main-only read-only environment jobs and publisher requires signed artifact", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const jobs = workflow.split(/^ {2}(?=[\w-]+:\n)/m).slice(1);
  const holders = jobs.filter((job) => job.includes("secrets."));
  assert.equal(holders.length, 2);
  for (const job of holders) {
    assert.match(job, /environment: Release/);
    assert.match(job, /permissions:\n {6}contents: read\n {4}steps:/);
    assert.match(job, /github.ref == 'refs\/heads\/main'/);
    assert.match(job, /if: always\(\)\n {8}run: node scripts\/macos-credentials.mjs cleanup/);
    assert.doesNotMatch(job, /run:.*secrets\./);
    assert.doesNotMatch(job, /pnpm run (make|build)|contents: write/);
  }
  const publisher = workflow.split("\n  nightly:\n")[1];
  assert.match(publisher, /needs: \[changes, quality, macos-sign\]/);
  assert.match(publisher, /needs.macos-sign.result == 'success'/);
  assert.match(publisher, /--name Foom-macos-signed/);
  assert.doesNotMatch(publisher, /secrets\./);
  assert.match(
    readFileSync(resolve("forge.config.js"), "utf8"),
    /appBundleId: "com.foom-term.foom"/,
  );
});

test("credential setup validates the team, restricts files and cleanup removes partial secrets", {
  skip: process.platform === "win32",
}, (t) => {
  const { root } = fixture(t);
  const bin = join(root, "credential-bin");
  mkdirSync(bin);
  const log = join(root, "security.jsonl");
  const command = join(bin, "security");
  writeFileSync(
    command,
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args[0]==='create-keychain')fs.writeFileSync(args.at(-1),'fixture-keychain');if(args[0]==='find-identity')console.log('  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: Fixture ('+(process.env.FIXTURE_TEAM||'TEAM')+')"\\n     1 valid identities found');\n`,
  );
  chmodSync(command, 0o755);
  const env = {
    PATH: bin,
    RUNNER_TEMP: root,
    MACOS_CERT_P12: Buffer.from("fixture-certificate").toString("base64"),
    MACOS_CERT_PASSWORD: "fixture-password",
    APPLE_API_KEY: "fixture-private-key",
    APPLE_API_KEY_ID: "fixture-id",
    APPLE_API_ISSUER: "fixture-issuer",
    APPLE_TEAM_ID: "TEAM",
  };
  const invoke = (mode, extra = {}) =>
    spawnSync(process.execPath, [resolve("scripts/macos-credentials.mjs"), mode], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  const setup = invoke("setup");
  assert.equal(setup.status, 0, setup.stderr);
  const directory = join(root, "foom-signing");
  for (const name of ["certificate.p12", "AuthKey.p8", "identity.json", "signing.keychain-db"])
    assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(directory, "certificate.p12"), "utf8"), "fixture-certificate");
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const password = calls.find((args) => args[0] === "create-keychain")[2];
  assert.match(password, /^[a-f0-9]{64}$/);
  assert.ok(setup.stdout.includes(`::add-mask::${password}`));
  assert.ok(setup.stdout.includes("::add-mask::Developer ID Application: Fixture (TEAM)"));
  assert.ok(calls.some((args) => args[0] === "import" && args.includes("fixture-password")));
  assert.equal(invoke("cleanup").status, 0);
  assert.equal(existsSync(directory), false);
  assert.equal(invoke("setup", { FIXTURE_TEAM: "OTHER" }).status, 1);
  assert.ok(
    existsSync(join(directory, "AuthKey.p8")),
    "failed setup is cleaned by the always step",
  );
  assert.equal(invoke("cleanup").status, 0);
  assert.equal(existsSync(directory), false);
  assert.equal(invoke("cleanup").status, 0, "cleanup tolerates setup that never started");
});

test("signing enforces hardened fuse values and detects ASAR or embedded-integrity changes", async (t) => {
  const { app } = fixture(t);
  const framework = join(
    app,
    "Contents/Frameworks/Electron Framework.framework/Electron Framework",
  );
  const binary = (first) =>
    Buffer.concat([
      Buffer.from("cffaedfe", "hex"),
      Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
      Buffer.from([1, 6, first, 49, 48, 48, 49, 49]),
      Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A"),
      Buffer.from([1, 1, ...Array(32).fill(42)]),
    ]);
  writeFileSync(framework, binary(48));
  const execute = (command) =>
    command === "/usr/libexec/PlistBuddy" ? "algorithm = SHA256; hash = fixture" : "";
  await signApp(app, { identity: "-" }, execute);
  writeFileSync(framework, binary(49));
  await assert.rejects(signApp(app, { identity: "-" }, execute), /Unexpected fuse 0/);
  writeFileSync(framework, binary(48));
  await assert.rejects(
    signApp(app, { identity: "-" }, () => "missing"),
    /Missing embedded ASAR integrity/,
  );
  await assert.rejects(
    signApp(app, { identity: "-" }, (command) => {
      if (command === "codesign")
        writeFileSync(join(app, "Contents/Resources/app.asar"), "tampered");
      return execute(command);
    }),
    /Signing changed fuses or ASAR integrity/,
  );
});
