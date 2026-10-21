import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { releaseSecretNames, run } from "./macos-sign.mjs";

const mask = (value) =>
  console.log(
    `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
  );
// security emits one quoted absolute path per line. Fail closed on unexpected
// output rather than silently dropping an existing keychain from the search list.
export function parseKeychains(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*"((?:[^"\\]|\\["\\])*)"\s*$/.exec(line);
      assert.ok(match, "Unexpected security list-keychains output");
      const path = match[1].replace(/\\(["\\])/g, "$1");
      assert.ok(path.startsWith("/") && !path.includes("\0"), "Expected absolute keychain path");
      return path;
    });
}

export async function credentials(mode) {
  const directory = join(process.env.RUNNER_TEMP, "foom-signing");
  const keychain = join(directory, "signing.keychain-db");
  const searchList = join(directory, "search-list.json");
  if (mode === "cleanup") {
    // Also safe after partially failed setup. No password is needed to delete.
    try {
      try {
        if (existsSync(searchList)) {
          const original = JSON.parse(await readFile(searchList, "utf8"));
          assert.ok(
            Array.isArray(original) &&
              original.every(
                (path) => typeof path === "string" && path.startsWith("/") && !path.includes("\0"),
              ),
            "Invalid saved keychain search list",
          );
          run("security", ["list-keychains", "-d", "user", "-s", ...original]);
        }
      } finally {
        if (existsSync(keychain)) run("security", ["delete-keychain", keychain]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } else if (mode === "setup") {
    for (const name of releaseSecretNames) {
      assert.ok(process.env[name], `Missing ${name}`);
      mask(process.env[name]);
    }
    await mkdir(directory, { mode: 0o700 });
    const password = randomBytes(32).toString("hex");
    mask(password);
    const certificate = join(directory, "certificate.p12");
    const p12 = Buffer.from(process.env.MACOS_CERT_P12, "base64");
    // The encrypted-file fingerprint is intentionally visible for local comparison.
    console.log(
      `Decoded P12: ${p12.length} bytes; SHA-256: ${createHash("sha256").update(p12).digest("hex")}`,
    );
    assert.ok(p12.length > 0, "MACOS_CERT_P12 decoded to 0 bytes; check its base64 encoding");
    assert.equal(p12[0], 0x30, "Decoded MACOS_CERT_P12 must start with an ASN.1 SEQUENCE (0x30)");
    await writeFile(certificate, p12, { mode: 0o600 });
    await writeFile(join(directory, "AuthKey.p8"), process.env.APPLE_API_KEY, { mode: 0o600 });
    // Snapshot before create-keychain, which can itself change the search list.
    const original = parseKeychains(run("security", ["list-keychains", "-d", "user"]));
    await writeFile(searchList, JSON.stringify(original), { mode: 0o600 });
    run("security", ["create-keychain", "-p", password, keychain]);
    await chmod(keychain, 0o600);
    run("security", ["set-keychain-settings", "-lut", "21600", keychain]);
    run("security", ["unlock-keychain", "-p", password, keychain]);
    try {
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
    } catch (error) {
      console.error(
        "Common causes: wrong MACOS_CERT_PASSWORD, or a .p12 exported without `openssl pkcs12 -export -legacy`.",
      );
      throw error;
    }
    run("security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      password,
      keychain,
    ]);
    run("security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      keychain,
      ...original.filter((path) => path !== keychain),
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
    assert.ok(
      matches[0][2].endsWith(` (${process.env.APPLE_TEAM_ID})`),
      "Certificate team mismatch",
    );
    console.log(identities);
    const probe = join(directory, "codesign-probe");
    try {
      await copyFile("/usr/bin/true", probe);
      await chmod(probe, 0o700);
      run("codesign", [
        "--force",
        "--sign",
        matches[0][1],
        "--keychain",
        keychain,
        "--timestamp=none",
        probe,
      ]);
      run("codesign", ["--verify", "--strict", probe]);
    } catch (error) {
      throw new Error("Release credential setup signing probe failed", { cause: error });
    } finally {
      await rm(probe, { force: true });
    }
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await credentials(process.argv[2]);
}
