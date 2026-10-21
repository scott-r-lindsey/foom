import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  testedZip,
  releaseSecretNames,
  entitlementFor,
  notarizeApp,
  run,
  redactOutput,
  signApp,
  signingArgs,
  signingOrder,
} from "./macos-sign.mjs";

import { parseKeychains } from "./macos-credentials.mjs";

test("keychain search-list parsing preserves paths, spaces, order and escaped quotes", () => {
  assert.deepEqual(
    parseKeychains(
      '    "/Users/runner/login.keychain-db"\n    "/path with spaces/other.keychain-db"\n',
    ),
    ["/Users/runner/login.keychain-db", "/path with spaces/other.keychain-db"],
  );
  assert.deepEqual(parseKeychains(""), []);
  assert.deepEqual(parseKeychains(String.raw`    "/path/with\"quote\\slash"`), [
    '/path/with"quote\\slash',
  ]);
  for (const output of ["unquoted", '"relative"', '"/unterminated', '"/ok" garbage'])
    assert.throws(() => parseKeychains(output));
});

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
  writeFileSync(
    join(app, "Contents/Resources/app.asar.unpacked/build/console/manifest.json"),
    JSON.stringify({ version: "fixture", sha256: "before signing" }),
  );
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
    (command, args) => {
      calls.push([command, args]);
      if (args.at(-1) === join(app, paths[5]))
        writeFileSync(join(app, paths[5]), "fixture changed by signing");
    },
    async () => ({ fuses: "unchanged", archive: "unchanged" }),
  );
  assert.equal(
    JSON.parse(
      readFileSync(
        join(app, "Contents/Resources/app.asar.unpacked/build/console/manifest.json"),
        "utf8",
      ),
    ).sha256,
    createHash("sha256")
      .update(readFileSync(join(app, paths[5])))
      .digest("hex"),
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
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args[0]==='list-keychains' && !args.includes('-s'))console.log('    "/Users/runner/login.keychain-db"\\n    "/path with spaces/other.keychain-db"');if(args[0]==='list-keychains' && args.includes('-s') && process.env.FIXTURE_LIST_FAIL)process.exit(1);if(args[0]==='create-keychain')fs.writeFileSync(args.at(-1),'fixture-keychain');if(args[0]==='import' && process.env.FIXTURE_IMPORT_FAIL){console.error('SecKeychainItemImport: MAC verification failed; password='+process.env.MACOS_CERT_PASSWORD);console.log('fixture import stdout; keychain='+args[args.indexOf('-k')+1]);process.exit(1);}if(args[0]==='find-identity')console.log('  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: Fixture ('+(process.env.FIXTURE_TEAM||'TEAM')+')"\\n     1 valid identities found');\n`,
  );
  chmodSync(command, 0o755);
  const codesign = join(bin, "codesign");
  writeFileSync(
    codesign,
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(['codesign',...args])+'\\n');if(process.env.FIXTURE_SIGN_FAIL){console.error('The specified item could not be found in the keychain. '+args[args.indexOf('--sign')+1]);process.exit(1);}\n`,
  );
  chmodSync(codesign, 0o755);
  const env = {
    PATH: bin,
    RUNNER_TEMP: root,
    MACOS_CERT_P12: Buffer.from("0fixture-certificate").toString("base64"),
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
  assert.ok(
    setup.stdout.includes(
      `Decoded P12: 20 bytes; SHA-256: ${createHash("sha256").update(Buffer.from("0fixture-certificate")).digest("hex")}`,
    ),
  );
  for (const name of [
    "certificate.p12",
    "AuthKey.p8",
    "identity.json",
    "signing.keychain-db",
    "search-list.json",
  ])
    assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(directory, "certificate.p12"), "utf8"), "0fixture-certificate");
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const original = ["/Users/runner/login.keychain-db", "/path with spaces/other.keychain-db"];
  assert.deepEqual(calls[0], ["list-keychains", "-d", "user"]);
  assert.deepEqual(
    calls.find((args) => args[0] === "list-keychains" && args.includes("-s")),
    ["list-keychains", "-d", "user", "-s", join(directory, "signing.keychain-db"), ...original],
  );
  assert.deepEqual(
    calls.filter((args) => args[0] === "codesign"),
    [
      [
        "codesign",
        "--force",
        "--sign",
        "A".repeat(40),
        "--keychain",
        join(directory, "signing.keychain-db"),
        "--timestamp=none",
        join(directory, "codesign-probe"),
      ],
      ["codesign", "--verify", "--strict", join(directory, "codesign-probe")],
    ],
  );
  assert.ok(!existsSync(join(directory, "codesign-probe")));
  const password = calls.find((args) => args[0] === "create-keychain")[2];
  assert.match(password, /^[a-f0-9]{64}$/);
  assert.ok(setup.stdout.includes(`::add-mask::${password}`));
  assert.ok(setup.stdout.includes("::add-mask::Developer ID Application: Fixture (TEAM)"));
  assert.ok(calls.some((args) => args[0] === "import" && args.includes("fixture-password")));
  assert.equal(invoke("cleanup").status, 0);
  assert.equal(existsSync(directory), false);
  const cleaned = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(cleaned.at(-2), ["list-keychains", "-d", "user", "-s", ...original]);
  assert.deepEqual(cleaned.at(-1), ["delete-keychain", join(directory, "signing.keychain-db")]);
  assert.equal(invoke("setup", { FIXTURE_TEAM: "OTHER" }).status, 1);
  assert.ok(
    existsSync(join(directory, "AuthKey.p8")),
    "failed setup is cleaned by the always step",
  );
  assert.equal(invoke("cleanup").status, 0);
  assert.equal(existsSync(directory), false);
  assert.equal(invoke("cleanup").status, 0, "cleanup tolerates setup that never started");
  const failedImport = invoke("setup", { FIXTURE_IMPORT_FAIL: "1" });
  assert.equal(failedImport.status, 1);
  assert.match(failedImport.stderr, /SecKeychainItemImport: MAC verification failed/);
  assert.match(failedImport.stderr, /fixture import stdout/);
  assert.match(failedImport.stderr, /wrong MACOS_CERT_PASSWORD/);
  assert.match(failedImport.stderr, /openssl pkcs12 -export -legacy/);
  assert.ok(!failedImport.stderr.includes(env.MACOS_CERT_PASSWORD));
  assert.ok(failedImport.stderr.includes(join(directory, "signing.keychain-db")));
  assert.equal(invoke("cleanup").status, 0);
  const failedProbe = invoke("setup", { FIXTURE_SIGN_FAIL: "1" });
  assert.equal(failedProbe.status, 1);
  assert.match(failedProbe.stderr, /setup signing probe failed/);
  assert.match(failedProbe.stderr, /specified item could not be found/);
  assert.ok(!failedProbe.stderr.includes("A".repeat(40)));
  assert.ok(!existsSync(join(directory, "identity.json")));
  assert.ok(!existsSync(join(directory, "codesign-probe")));
  assert.equal(invoke("cleanup").status, 0);
  const failedList = invoke("setup", { FIXTURE_LIST_FAIL: "1" });
  assert.equal(failedList.status, 1);
  assert.equal(invoke("cleanup").status, 0, "restore original list after setup list update fails");
  const partialCalls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(partialCalls.at(-2), ["list-keychains", "-d", "user", "-s", ...original]);
  assert.equal(invoke("setup").status, 0);
  assert.equal(invoke("cleanup", { FIXTURE_LIST_FAIL: "1" }).status, 1);
  assert.equal(existsSync(directory), false, "delete keychain and secrets even if restore fails");
  assert.equal(
    JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1))[0],
    "delete-keychain",
  );
  for (const [certificate, message] of [
    ["%%", /decoded to 0 bytes/],
    [Buffer.from("not ASN.1").toString("base64"), /ASN.1 SEQUENCE \(0x30\)/],
  ]) {
    writeFileSync(log, "");
    const invalid = invoke("setup", { MACOS_CERT_P12: certificate });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, message);
    assert.match(invalid.stdout, /Decoded P12: \d+ bytes; SHA-256: [a-f0-9]{64}/);
    assert.equal(readFileSync(log, "utf8"), "", "reject malformed P12 before keychain operations");
    assert.equal(existsSync(join(directory, "certificate.p12")), false);
    assert.equal(invoke("cleanup").status, 0);
  }
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

test("redacts sensitive argument values and environment credentials as literals without hiding tool diagnostics", () => {
  const secrets = ["prefix", "prefix-longer", "punctuation.$[x]", "key-id-value", "issuer-value"];
  const args = [
    "set-key-partition-list",
    ...secrets.flatMap((value, index) => [
      ["-k", "-P", "-k", "--key-id", "--issuer"][index],
      value,
    ]),
  ];
  const env = {
    MACOS_CERT_P12: "base64-value",
    MACOS_CERT_PASSWORD: "env-password",
    APPLE_API_KEY:
      "-----BEGIN PRIVATE KEY-----\nprivate-key-line-long-enough\n-----END PRIVATE KEY-----",
    APPLE_API_KEY_ID: "env-key-id",
    APPLE_API_ISSUER: "env-issuer",
    APPLE_TEAM_ID: "env-team",
    EMPTY_SECRET: "",
    UNDEFINED_SECRET: undefined,
    PUBLIC_VALUE: "ordinary diagnostic",
  };
  const output = `ordinary diagnostic: ${[...secrets, ...Object.values(env).filter(Boolean), "private-key-line-long-enough", secrets[1]].join("\n")}`;
  const redacted = redactOutput(output, args, env, "security");
  for (const value of [
    ...secrets,
    ...Object.entries(env)
      .filter(([name, value]) => name !== "PUBLIC_VALUE" && value)
      .map(([_name, value]) => value),
    "private-key-line-long-enough",
  ])
    assert.ok(!redacted.includes(value));
  assert.ok(redacted.startsWith("ordinary diagnostic:"));
  assert.ok(!redacted.includes("-longer"), "overlapping credentials are redacted longest first");
  assert.equal(redactOutput("message", ["-p", ""], {}), "message");
  assert.equal(redactOutput("x", ["-p"], {}), "x");
});

test("run reports both redacted tool streams on failure without appending argv", (t) => {
  const previous = process.env.APPLE_API_KEY_ID;
  process.env.APPLE_API_KEY_ID = "fixture-env-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.APPLE_API_KEY_ID;
    else process.env.APPLE_API_KEY_ID = previous;
  });
  const program = `console.error('import rejected: fixture-password'); console.log('stdout detail: '+process.env.APPLE_API_KEY_ID); process.exit(1);`;
  assert.throws(
    () =>
      run(process.execPath, [
        "-e",
        program,
        "--",
        "--key-id",
        "fixture-password",
        "argv-must-not-be-printed",
      ]),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /import rejected: \[REDACTED\]/);
      assert.match(error.message, /stdout detail: \[REDACTED\]/);
      assert.ok(!error.message.includes("fixture-password"));
      assert.ok(!error.message.includes("fixture-env-secret"));
      assert.ok(!error.message.includes("argv-must-not-be-printed"));
      assert.ok(!error.message.includes(program));
      return true;
    },
  );
  assert.equal(
    run(process.execPath, ["-e", "process.stdout.write('successful tool output')"]),
    "successful tool output",
  );
});

test("tested ZIP discovery handles downloaded artifact paths and rejects zero or multiple ZIPs", async (t) => {
  const { root } = fixture(t);
  const download = join(root, "tested-macos");
  const nested = join(download, "zip/darwin/arm64");
  mkdirSync(nested, { recursive: true });
  await assert.rejects(testedZip(download), /Expected exactly one tested ZIP.*found 0/);
  const zip = join(nested, "Foom-darwin-arm64-0.1.0.zip");
  writeFileSync(zip, "tested archive");
  mkdirSync(join(download, "directory.zip"));
  writeFileSync(join(download, "report.txt"), "not a zip");
  assert.equal(await testedZip(download), zip);
  writeFileSync(join(download, "extra.zip"), "ambiguous archive");
  await assert.rejects(testedZip(download), /Expected exactly one tested ZIP.*found 2/);
});

test("ditto ZIP paths, keychain paths and unrelated environment values remain in diagnostics", () => {
  const path = "/runner/tested-macos/*.zip";
  const env = {
    GITHUB_TOKEN: "unrelated-token",
    SOME_KEY_PATH: path,
    CERT_PATH: "/runner/certificate.p12",
    APPLE_API_KEY:
      "-----BEGIN PRIVATE KEY-----\nlong-private-material-line\nabc\n-----END PRIVATE KEY-----",
  };
  const diagnostic = `ditto: ${path}: No such file or directory`;
  assert.equal(redactOutput(diagnostic, ["-x", "-k", path, "/unpacked"], env, "ditto"), diagnostic);
  assert.equal(
    redactOutput("abc unrelated-token /runner/certificate.p12", [], env),
    "abc unrelated-token /runner/certificate.p12",
  );
  assert.equal(redactOutput("long-private-material-line", [], env), "[REDACTED]");
  assert.equal(
    redactOutput("/runner/keychain", ["import", "cert", "-k", "/runner/keychain"], {}, "security"),
    "/runner/keychain",
  );
  for (const action of ["create-keychain", "unlock-keychain"]) {
    assert.equal(
      redactOutput("random-password", [action, "-p", "random-password"], {}, "security"),
      "[REDACTED]",
    );
  }
  for (const name of releaseSecretNames) {
    assert.equal(redactOutput("release-secret", [], { [name]: "release-secret" }), "[REDACTED]");
  }
});

test("PR ad-hoc signing downloads the same artifact and uses the release ZIP discovery", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const platform = workflow.split("\n  platform:\n")[1].split("\n  quality:\n")[0];
  assert.match(platform, /runner.os == 'macOS' \|\|/);
  assert.match(platform, /name: Foom-\$\{\{ matrix.os \}\}\n {10}path: out\/make\/\*\*\/\*\.zip/);
  assert.match(platform, /name: Foom-macos-15\n {10}path: tested-macos/);
  assert.match(platform, /macos-sign.mjs adhoc-zip tested-macos/);
  assert.match(workflow, /macos-sign.mjs release tested-macos/);
});
