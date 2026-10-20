import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./macos-sign.mjs";

const directory = join(process.env.RUNNER_TEMP, "foom-signing");
const keychain = join(directory, "signing.keychain-db");
const mask = (value) =>
  console.log(
    `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
  );
const mode = process.argv[2];
if (mode === "cleanup") {
  // Also safe after partially failed setup. No password is needed to delete.
  try {
    if (existsSync(keychain)) run("security", ["delete-keychain", keychain]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} else if (mode === "setup") {
  for (const name of [
    "MACOS_CERT_P12",
    "MACOS_CERT_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_TEAM_ID",
  ]) {
    assert.ok(process.env[name], `Missing ${name}`);
    mask(process.env[name]);
  }
  await mkdir(directory, { mode: 0o700 });
  const password = randomBytes(32).toString("hex");
  mask(password);
  const certificate = join(directory, "certificate.p12");
  await writeFile(certificate, Buffer.from(process.env.MACOS_CERT_P12, "base64"), { mode: 0o600 });
  await writeFile(join(directory, "AuthKey.p8"), process.env.APPLE_API_KEY, { mode: 0o600 });
  run("security", ["create-keychain", "-p", password, keychain]);
  await chmod(keychain, 0o600);
  run("security", ["set-keychain-settings", "-lut", "21600", keychain]);
  run("security", ["unlock-keychain", "-p", password, keychain]);
  run("security", [
    "import",
    certificate,
    "-k",
    keychain,
    "-P",
    process.env.MACOS_CERT_PASSWORD,
    "-T",
    "/usr/bin/codesign",
    "-T",
    "/usr/bin/security",
  ]);
  run("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    password,
    keychain,
  ]);
  const identities = run("security", ["find-identity", "-v", "-p", "codesigning", keychain]);
  const matches = [
    ...identities.matchAll(/\b([A-Fa-f0-9]{40}) "(Developer ID Application: [^"\r\n]+)"/g),
  ];
  // Mask every derived identity before assertions can include tool output.
  for (const match of matches) {
    mask(match[1]);
    mask(match[2]);
  }
  assert.equal(matches.length, 1, "Expected exactly one Developer ID Application identity");
  assert.match(identities, /\b1 valid identities found/);
  assert.ok(matches[0][2].endsWith(` (${process.env.APPLE_TEAM_ID})`), "Certificate team mismatch");
  console.log(identities);
  await writeFile(
    join(directory, "identity.json"),
    JSON.stringify({ identity: matches[0][1], keychain }),
    { mode: 0o600 },
  );
} else if (mode === "check") {
  console.log(
    run("xcrun", [
      "notarytool",
      "history",
      "--key",
      join(directory, "AuthKey.p8"),
      "--key-id",
      process.env.APPLE_API_KEY_ID,
      "--issuer",
      process.env.APPLE_API_ISSUER,
    ]),
  );
} else throw new Error("Expected setup, check or cleanup");
