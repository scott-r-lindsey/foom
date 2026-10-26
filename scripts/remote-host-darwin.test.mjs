import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "./remote-host-artifacts.mjs";
import { assembleDarwinHost, darwinInputNames, verifyDarwinInputs } from "./remote-host-darwin.mjs";

const source = "a".repeat(40);
async function fixture(t, arch = "arm64") {
  const root = await mkdtemp(join(tmpdir(), "foom-darwin-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = join(root, "inputs");
  await mkdir(inputs);
  const manifest = {
    format: 1,
    protocol: 1,
    platform: "darwin",
    arch,
    source,
    version: "0.1.0",
    nodeVersion: process.version,
    files: {},
  };
  for (const name of darwinInputNames) {
    const bytes = Buffer.from(`fixture ${name}`);
    await writeFile(join(inputs, name), bytes);
    manifest.files[name] = { size: bytes.length, sha256: digest(bytes) };
  }
  await writeFile(join(inputs, "manifest.json"), JSON.stringify(manifest));
  return { root, inputs, manifest };
}

function appleFixture(
  calls,
  { identity = "-", team = "FIXTURE123", nativeTeam = team, entitlements } = {},
) {
  return (command, args) => {
    calls.push([command, args]);
    if (args.includes("--verbose=4"))
      return `TeamIdentifier=${args.at(-1).endsWith("foom-host") ? team : nativeTeam}\n`;
    if (args.includes("--entitlements") && args.includes("--display"))
      return (
        entitlements ??
        `<dict><key>com.apple.security.cs.allow-jit</key><true/>${identity === "-" ? "<key>com.apple.security.cs.disable-library-validation</key><true/>" : ""}</dict>`
      );
    return "";
  };
}

test("Darwin input validation rejects missing, corrupt, mismatched and unsafe inputs before signing", async (t) => {
  const { root, inputs, manifest } = await fixture(t);
  await verifyDarwinInputs(inputs, "darwin-arm64", "0.1.0", source);
  const path = join(inputs, "manifest.json");
  for (const patch of [
    null,
    { format: 2 },
    { protocol: 2 },
    { platform: "linux" },
    { arch: "x64" },
    { source: "b".repeat(40) },
    { version: "0.2.0" },
    { nodeVersion: "v24.0.0" },
    { files: {} },
    { files: { ...manifest.files, unknown: {} } },
  ]) {
    await writeFile(path, JSON.stringify(patch === null ? null : { ...manifest, ...patch }));
    const calls = [];
    await assert.rejects(
      assembleDarwinHost(
        inputs,
        join(root, "output"),
        "darwin-arm64",
        "0.1.0",
        source,
        { identity: "-" },
        appleFixture(calls),
      ),
    );
    assert.equal(calls.length, 0);
  }
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(verifyDarwinInputs(inputs, "linux-arm64", "0.1.0", source), /target/);
  await assert.rejects(verifyDarwinInputs(inputs, "darwin-arm64", "0.1.0", "bad"), /source/);
  for (const patch of [
    { size: 0 },
    { size: 201 * 1024 * 1024 },
    { size: 100 },
    { sha256: "invalid" },
    { sha256: "b".repeat(64) },
  ]) {
    await writeFile(
      path,
      JSON.stringify({
        ...manifest,
        files: { ...manifest.files, node: { ...manifest.files.node, ...patch } },
      }),
    );
    await assert.rejects(verifyDarwinInputs(inputs, "darwin-arm64", "0.1.0", source));
  }
  await writeFile(path, JSON.stringify(manifest));
  await writeFile(join(inputs, "pty.node"), "tampered bytes");
  await assert.rejects(verifyDarwinInputs(inputs, "darwin-arm64", "0.1.0", source));
  await rm(join(inputs, "pty.node"));
  await assert.rejects(verifyDarwinInputs(inputs, "darwin-arm64", "0.1.0", source), /ENOENT/);
  if (process.platform !== "win32") {
    await symlink(join(inputs, "node"), join(inputs, "pty.node"));
    await assert.rejects(verifyDarwinInputs(inputs, "darwin-arm64", "0.1.0", source), /type/);
  }
});

test("Darwin assembly signs native copies before embedding and enforces host entitlements and matching teams", async (t) => {
  for (const arch of ["arm64", "x64"])
    for (const identity of ["-", "Developer ID Application: Fixture"]) {
      const { root, inputs, manifest } = await fixture(t, arch);
      const output = join(root, "output");
      const calls = [];
      await assembleDarwinHost(
        inputs,
        output,
        `darwin-${arch}`,
        "0.1.0",
        source,
        { identity, keychain: "/fixture/keychain" },
        appleFixture(calls, { identity, team: "FIXTURE123" }),
      );
      const signCalls = calls.filter(
        ([command, args]) => command === "codesign" && args.includes("--sign"),
      );
      assert.deepEqual(
        signCalls.map(([, args]) => args.at(-1)),
        [join(output, "pty.node"), join(output, "spawn-helper"), join(output, "foom-host")],
      );
      for (const [, args] of signCalls) {
        assert.ok(args.includes(identity));
        assert.ok(args.includes("runtime"));
        assert.ok(args.includes(identity === "-" ? "--timestamp=none" : "--timestamp"));
        assert.ok(!args.includes("--deep"));
      }
      assert.ok(!signCalls[0][1].includes("--entitlements"));
      assert.ok(
        signCalls[2][1].some((arg) =>
          arg.endsWith(
            identity === "-" ? "entitlements-adhoc.plist" : "entitlements-remote-host.plist",
          ),
        ),
      );
      const config = JSON.parse(await readFile(join(output, "sea.json"), "utf8"));
      assert.equal(config.useSnapshot, false);
      assert.equal(config.useCodeCache, false);
      assert.equal(config.execArgvExtension, "none");
      assert.deepEqual(config.assets, {
        "pty.node": join(output, "pty.node"),
        "spawn-helper": join(output, "spawn-helper"),
      });
      const blobIndex = calls.findIndex(([, args]) => args[0] === "--experimental-sea-config");
      assert.ok(
        calls.findIndex(
          ([, args]) => args.includes("--verify") && args.at(-1).endsWith("spawn-helper"),
        ) < blobIndex,
      );
      assert.ok(
        calls.some(
          ([, args]) => args.includes("--macho-segment-name") && args.includes("NODE_SEA"),
        ),
      );
      assert.equal(
        digest(await readFile(join(inputs, "pty.node"))),
        manifest.files["pty.node"].sha256,
        "unsigned inputs remain unchanged",
      );
      for (const options of [
        { team: "FIXTURE123", nativeTeam: "OTHER12345" },
        { team: "not-a-team" },
        { entitlements: "<dict/>" },
        {
          entitlements:
            "<dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict>",
        },
      ]) {
        await assert.rejects(
          assembleDarwinHost(
            inputs,
            output,
            `darwin-${arch}`,
            "0.1.0",
            source,
            { identity: "Developer ID Application: Fixture" },
            appleFixture([], { identity: "Developer ID Application: Fixture", ...options }),
          ),
        );
      }
      for (const failAt of ["sign", "verify", "blob", "inject"]) {
        await assert.rejects(
          assembleDarwinHost(
            inputs,
            output,
            `darwin-${arch}`,
            "0.1.0",
            source,
            { identity: "-" },
            (command, args) => {
              if (
                (failAt === "sign" && args.includes("--sign")) ||
                (failAt === "verify" && args.includes("--verify")) ||
                (failAt === "blob" && args.includes("--experimental-sea-config")) ||
                (failAt === "inject" && args.includes("NODE_SEA_BLOB"))
              )
                throw new Error(`fixture ${failAt} failure`);
              return appleFixture([])(command, args);
            },
          ),
          new RegExp(`fixture ${failAt} failure`),
        );
      }
    }
});
