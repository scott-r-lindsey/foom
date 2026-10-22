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
import { inspect } from "node:util";
import {
  testedZip,
  releaseSecretNames,
  entitlementFor,
  notarizeApp,
  notarizationSession,
  notarizationDeadlineMs,
  signDmg,
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
      `#!${process.execPath}\nconst {appendFileSync}=require('node:fs');\nconst args=process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)},JSON.stringify([${JSON.stringify(name)},args])+'\\n');\nif (${JSON.stringify(name)} === 'xcrun' && args[0] === 'notarytool' && ['submit','info'].includes(args[1])) console.log(JSON.stringify({id:'fixture-id',status:'Accepted'}));\nif (${JSON.stringify(name)} === 'spctl') console.log(process.env.FIXTURE_ASSESSMENT || 'source=Notarized Developer ID');\n`,
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
    "--no-progress",
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

test("ad-hoc signing failures preserve hyphens and paths while Developer ID hashes are redacted", () => {
  const diagnostic = "codesign: /runner/tested-macos/Foom-helper: code-object is not signed-at-all";
  assert.equal(redactOutput(diagnostic, ["--sign", "-"], {}, "codesign"), diagnostic);
  const identity = "0123456789ABCDEF0123456789ABCDEF01234567";
  assert.equal(
    redactOutput(`${diagnostic}; identity=${identity}`, ["--sign", identity], {}, "codesign"),
    `${diagnostic}; identity=[REDACTED]`,
  );
  for (const flag of ["--sign", "--key", "--key-id", "--issuer", "-P", "-p", "-k"]) {
    for (const value of ["-", "ab", "abc"]) {
      assert.equal(
        redactOutput(`${diagnostic}; ${value}`, ["create-keychain", flag, value], {}, "security"),
        `${diagnostic}; ${value}`,
      );
    }
  }
  // All six configured secrets stay covered without an argv length threshold.
  for (const name of releaseSecretNames)
    assert.equal(redactOutput("abc", [], { [name]: "abc" }), "[REDACTED]");
  assert.equal(
    redactOutput("abcd", ["unlock-keychain", "-p", "abcd"], {}, "security"),
    "[REDACTED]",
  );
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
  assert.match(platform, /name: Foom-\$\{\{ matrix.os \}\}\n {10}path: out\/make\//);
  assert.match(platform, /name: Foom-macos-15\n {10}path: tested-macos/);
  assert.match(platform, /macos-sign.mjs adhoc-zip tested-macos/);
  assert.match(workflow, /macos-sign.mjs release tested-macos/);
});

test("fixture notarytool polls ZIP/DMG, summarizes rejection, redacts diagnostics and bounds the shared deadline", {
  skip: process.platform === "win32",
}, async (t) => {
  const { root, app } = fixture(t);
  const bin = join(root, "notary-bin");
  mkdirSync(bin);
  const callsFile = join(root, "notary-calls.jsonl");
  const countFile = join(root, "info-count");
  const credentials = {
    identity: "fixture-signing-identity",
    keychain: "fixture-keychain",
    appleApiKey: "fixture-api-key-path",
    appleApiKeyId: "fixture-api-key-id",
    appleApiIssuer: "fixture-api-issuer",
  };
  const secret = Object.values(credentials).slice(2).join(" ");
  for (const name of ["xcrun", "codesign", "spctl", "ditto"]) {
    const file = join(bin, name);
    writeFileSync(
      file,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify([${JSON.stringify(name)}, args])+'\\n');
if (${JSON.stringify(name)} === 'spctl') console.log('source=Notarized Developer ID');
if (${JSON.stringify(name)} === 'xcrun' && args[0] === 'notarytool') {
  const mode = process.env.FIXTURE_NOTARY_MODE;
  if (mode === 'error') { console.error(${JSON.stringify(secret)}); process.exit(1); }
  if (mode === 'malformed') { console.log(${JSON.stringify(secret)}); process.exit(0); }
  if (args[1] === 'submit') console.log(JSON.stringify({id: mode === 'secret-id' ? ${JSON.stringify(secret)} : 'id-' + require('node:path').basename(args[2])}));
  if (args[1] === 'info') {
    const count = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)},'utf8')) : 0;
    fs.writeFileSync(${JSON.stringify(countFile)}, String(count+1));
    console.log(JSON.stringify({status: mode === 'slow' && count < 2 || mode === 'deadline' ? 'In Progress' : mode === 'invalid' ? 'Invalid' : mode === 'rejected' ? 'Rejected' : 'Accepted'}));
  }
  if (args[1] === 'log') console.log(JSON.stringify({statusSummary:'Invalid signature '+${JSON.stringify(secret)},issues:[{severity:'error',path:'Foom.app',message:'fixture issue '+${JSON.stringify(secret)}}]}));
}
`,
    );
    chmodSync(file, 0o755);
  }
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.PATH = bin;
  const calls = () =>
    readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  for (const mode of [
    "accepted",
    "slow",
    "invalid",
    "rejected",
    "deadline",
    "error",
    "malformed",
    "secret-id",
  ]) {
    process.env.FIXTURE_NOTARY_MODE = mode;
    writeFileSync(callsFile, "");
    rmSync(countFile, { force: true });
    const messages = [];
    let time = 0;
    const session = notarizationSession({
      deadlineMs: 100,
      pollMs: 30,
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
      log: (message) => messages.push(message),
    });
    const execute = (command, args, options) => {
      if (args[0] === "notarytool") {
        assert.equal(options.killSignal, "SIGKILL");
        assert.ok(options.timeout > 0 && options.timeout <= 100);
        assert.ok(!args.includes("--wait"));
      }
      return run(command, args); // Clock is simulated; fixture startup uses real wall time.
    };
    const action = () => notarizeApp(app, credentials, execute, session);
    if (["accepted", "slow", "secret-id"].includes(mode)) {
      await action();
      await signDmg("signed.dmg", credentials, execute, session);
      const trace = calls();
      for (const target of [app, "signed.dmg"]) {
        const stapleIndex = trace.findIndex(
          ([, args]) => args[0] === "stapler" && args[1] === "staple" && args[2] === target,
        );
        assert.ok(stapleIndex > trace.findIndex(([, args]) => args[1] === "info"));
      }
      assert.match(messages.join("\n"), /Accepted/);
      if (mode === "slow") {
        assert.equal(time, 60);
        assert.equal(messages.filter((line) => line.endsWith("In Progress")).length, 2);
      }
    } else {
      await assert.rejects(action, (error) => {
        messages.push(inspect(error));
        return true;
      });
      assert.ok(!calls().some(([, args]) => args[0] === "stapler"));
      if (["invalid", "rejected"].includes(mode)) {
        assert.ok(calls().some(([, args]) => args[1] === "log"));
        assert.match(messages.join("\n"), /fixture issue/);
      }
      if (mode === "deadline") {
        assert.equal(time, 100);
        assert.match(messages.join("\n"), /deadline exceeded.*id-Foom.zip \(In Progress\)/);
      }
    }
    assert.match(messages[0], /^\[1970-01-01T00:00:00.000Z\]/);
    for (const value of Object.values(credentials).slice(2))
      assert.ok(!messages.join("\n").includes(value));
  }
  // The second artifact uses the first artifact's remaining budget and reports
  // both IDs, including the accepted ZIP, when it expires.
  process.env.FIXTURE_NOTARY_MODE = "accepted";
  let time = 0;
  const messages = [];
  const shared = notarizationSession({
    deadlineMs: 10,
    pollMs: 5,
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    log: (line) => messages.push(line),
  });
  const unboundedFixture = (command, args) => run(command, args);
  await notarizeApp(app, credentials, unboundedFixture, shared);
  process.env.FIXTURE_NOTARY_MODE = "deadline";
  await assert.rejects(
    signDmg("signed.dmg", credentials, unboundedFixture, shared),
    /deadline exceeded.*id-Foom.zip \(Accepted\).*id-signed.dmg \(In Progress\)/,
  );
  assert.equal(time, 10);
});

test("fixture stapler retries app/DMG staple and validate within the shared deadline", {
  skip: process.platform === "win32",
}, async (t) => {
  const { root, app } = fixture(t);
  const bin = join(root, "stapler-bin");
  mkdirSync(bin);
  const countFile = join(root, "stapler-count");
  for (const name of ["xcrun", "codesign", "ditto", "spctl"]) {
    const file = join(bin, name);
    writeFileSync(
      file,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (${JSON.stringify(name)} === 'spctl') console.log('source=Notarized Developer ID');
if (${JSON.stringify(name)} === 'xcrun') {
  if (args[0] === 'notarytool') console.log(JSON.stringify({id:'fixture-submission-id',status:'Accepted'}));
  if (args[0] === 'stapler' && args[1] === process.env.FIXTURE_STAPLER_OPERATION) {
    const count = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) + 1 : 1;
    fs.writeFileSync(${JSON.stringify(countFile)}, String(count));
    if (count <= Number(process.env.FIXTURE_STAPLER_FAILURES)) {
      console.error(process.env.FIXTURE_STAPLER_ERROR + ' failure-' + count + ' fixture-secret-key');
      process.exit(68);
    }
  }
}
`,
    );
    chmodSync(file, 0o755);
  }
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.PATH = bin;
  const credentials = {
    appleApiKey: "fixture-secret-key",
    appleApiKeyId: "fixture-key-id",
    appleApiIssuer: "fixture-issuer",
  };
  const scenarios = [
    { error: "", failures: 0, attempts: 1 },
    {
      error: 'NSURLErrorDomain Code=-1005 "The network connection was lost."',
      failures: 1,
      attempts: 2,
    },
    { error: "CloudKit ticket delivery failed", failures: 1, attempts: 2 },
    { error: "Record not found", failures: 1, attempts: 2 },
    { error: "The staple and validate action failed! Error 65.", failures: 1, attempts: 2 },
    {
      error: "The staple and validate action failed! Error 68.",
      failures: 9,
      attempts: 6,
      rejects: true,
    },
    { error: "Invalid signature", failures: 9, attempts: 1, rejects: true },
    { error: "CloudKit network failure", failures: 9, attempts: 2, rejects: true, deadlineMs: 50 },
  ];
  for (const target of [app, "signed.dmg"]) {
    for (const operation of ["staple", "validate"]) {
      for (const scenario of scenarios) {
        rmSync(countFile, { force: true });
        process.env.FIXTURE_STAPLER_OPERATION = operation;
        process.env.FIXTURE_STAPLER_ERROR = scenario.error;
        process.env.FIXTURE_STAPLER_FAILURES = String(scenario.failures);
        let time = 0;
        const messages = [];
        const waits = [];
        const session = notarizationSession({
          deadlineMs: scenario.deadlineMs ?? 1000,
          stapleRetryMs: 30,
          queryTimeoutMs: 100,
          now: () => time,
          wait: async (ms) => {
            waits.push(ms);
            time += ms;
          },
          log: (line) => messages.push(line),
        });
        const execute = (command, args, options) => {
          if (args[0] === "stapler") {
            assert.equal(options.killSignal, "SIGKILL");
            assert.equal(options.timeout, Math.min(100, (scenario.deadlineMs ?? 1000) - time));
          }
          return run(command, args); // Only fixture processes; simulated clock.
        };
        const action = () =>
          target === app
            ? notarizeApp(target, credentials, execute, session)
            : signDmg(target, credentials, execute, session);
        if (scenario.rejects) {
          await assert.rejects(action, (error) => {
            assert.match(error.message, /fixture-submission-id \(Accepted\)/);
            assert.ok(error.message.includes(`failure-${scenario.attempts}`));
            assert.ok(!inspect(error).includes(credentials.appleApiKey));
            if (scenario.deadlineMs) assert.match(error.message, /deadline exceeded/);
            return true;
          });
        } else await action();
        assert.equal(Number(readFileSync(countFile, "utf8")), scenario.attempts);
        const results = messages.filter(
          (line) => line.includes(`stapler ${operation} attempt`) && line.includes("exit status"),
        );
        assert.equal(results.length, scenario.attempts);
        for (const line of results) {
          assert.match(line, /^\[1970-01-01T/);
          assert.ok(line.includes(target === app ? "Foom.app" : "signed.dmg"));
          assert.match(line, /exit status (?:0|68)/);
        }
        assert.ok(!messages.join("\n").includes(credentials.appleApiKey));
        assert.equal(waits.length, scenario.attempts - 1 + (scenario.deadlineMs ? 1 : 0));
        if (scenario.deadlineMs) {
          assert.deepEqual(waits, [30, 20]);
          assert.equal(time, scenario.deadlineMs);
        }
      }
    }
  }
});

test("notarization job leaves overhead beyond the single shared 120-minute budget", () => {
  assert.equal(notarizationDeadlineMs, 120 * 60 * 1000);
  const job = readFileSync(".github/workflows/ci.yml", "utf8")
    .split("\n  macos-sign:\n")[1]
    .split("\n  macos-credentials:\n")[0];
  const minutes = Number(job.match(/timeout-minutes: (\d+)/)[1]);
  assert.ok(minutes >= notarizationDeadlineMs / 60_000 + 30);
});

test("stalled notarytool commands are killed with bounded, redacted diagnostics", async () => {
  assert.throws(
    () =>
      run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        timeout: 50,
        killSignal: "SIGKILL",
      }),
    /timed out/,
  );
  let time = 0;
  const messages = [];
  const session = notarizationSession({
    deadlineMs: 10,
    now: () => time,
    log: (line) => messages.push(line),
  });
  const credentials = {
    appleApiKey: "fixture-key",
    appleApiKeyId: "fixture-id",
    appleApiIssuer: "fixture-issuer",
  };
  await assert.rejects(
    session("slow.zip", credentials, (_command, args) => {
      if (args[1] === "submit") return JSON.stringify({ id: "stalled-id" });
      time = 10;
      throw new Error("xcrun timed out fixture-key fixture-id fixture-issuer");
    }),
    /deadline exceeded.*submissions: slow.zip: stalled-id \(Submitted\)/,
  );
  for (const value of Object.values(credentials)) assert.ok(!messages.join("\n").includes(value));
});

test("streamed submit outlives the query cap, logs its ID before completion, and obeys the overall budget", {
  skip: process.platform === "win32",
}, async (t) => {
  const { root } = fixture(t);
  const bin = join(root, "upload-bin");
  mkdirSync(bin);
  const marker = join(root, "id-logged");
  const tool = join(bin, "xcrun");
  writeFileSync(
    tool,
    `#!${process.execPath}
const fs = require('node:fs');
setTimeout(() => process.exit(2), 5000).unref();
if (process.argv[3] === 'submit') {
  process.stdout.write('  id: slow-');
  setTimeout(() => process.stdout.write('upload-id\\n'), 20);
  const interval = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(marker)})) return;
    clearInterval(interval);
    if (process.env.HANG_UPLOAD === 'yes') setInterval(() => {}, 1000);
    else setTimeout(() => { console.log('Successfully uploaded file'); }, 1200);
  }, 10);
} else console.log(JSON.stringify({status:'Accepted'}));
`,
  );
  chmodSync(tool, 0o755);
  const credentials = {
    appleApiKey: "fixture-key",
    appleApiKeyId: "fixture-key-id",
    appleApiIssuer: "fixture-issuer",
  };
  for (const hang of [false, true]) {
    rmSync(marker, { force: true });
    const messages = [];
    const timeouts = [];
    const start = Date.now();
    const session = notarizationSession({
      deadlineMs: hang ? 4000 : 120000,
      queryTimeoutMs: 1000,
      log(message) {
        messages.push(message);
        if (message.includes("submission ID: slow-upload-id")) writeFileSync(marker, "logged");
      },
    });
    const execute = (command, args, options) => {
      timeouts.push([args[1], options.timeout]);
      return run(command, args, {
        ...options,
        env: { PATH: bin, HANG_UPLOAD: hang ? "yes" : "no" },
      });
    };
    const action = session("Foom.zip", credentials, execute);
    if (hang) {
      await assert.rejects(
        action,
        /Notarization deadline exceeded; xcrun timed out[\s\S]*slow-upload-id \(Submitted\)/,
      );
      assert.deepEqual(
        timeouts.map(([operation]) => operation),
        ["submit"],
      );
    } else {
      await action;
      assert.ok(Date.now() - start > 1000);
      assert.ok(timeouts[0][1] > 60_000);
      assert.deepEqual(timeouts[1], ["info", 1000]);
      assert.match(messages.at(-1), /slow-upload-id: Accepted/);
    }
    assert.equal(messages.filter((line) => line.includes("submission ID:")).length, 1);
  }
});

test("streamed command failures redact credentials and handle missing executables", async () => {
  await assert.rejects(
    run(
      process.execPath,
      [
        "-e",
        "process.stderr.write(process.argv.at(-1)); process.exit(1)",
        "--",
        "--key",
        "fixture-stream-secret",
      ],
      { timeout: 10000, onOutput() {} },
    ),
    (error) => {
      assert.match(error.message, /failed:\n\[REDACTED\]/);
      assert.ok(!inspect(error).includes("fixture-stream-secret"));
      return true;
    },
  );
  await assert.rejects(
    run("missing-streamed-command", [], {
      timeout: 10000,
      onOutput() {},
    }),
    { message: "missing-streamed-command failed" },
  );
});
