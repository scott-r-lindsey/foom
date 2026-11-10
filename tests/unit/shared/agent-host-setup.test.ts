import { expect, test } from "vitest";
import codex from "../../../src/shared/bundled-agents/codex.json";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";
test("optional host setup recipes accept only fixed package-manager argv and agent sign-in commands", () => {
  const good = {
    debian: ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", "codex"],
    rhel: ["/usr/bin/sudo", "/usr/bin/dnf", "install", "-y", "codex"],
    arch: ["/usr/bin/sudo", "/usr/bin/pacman", "-S", "--noconfirm", "codex"],
    darwin: ["brew", "install", "--cask", "codex"],
  };
  expect(
    parseAgentManifest(JSON.stringify({ ...codex, hostSetup: { install: good } }), "bundled").model
      .hostSetup?.install,
  ).toEqual(good);
  for (const install of [
    { debian: ["/bin/sh", "-c", "curl vendor | sh"] },
    { darwin: ["brew", "install", "--formula", "codex"] },
    { rhel: ["/usr/bin/sudo", "/usr/bin/dnf", "install", "-y", "https://vendor/installer"] },
    { arch: ["/usr/bin/sudo", "/usr/bin/pacman", "-S", "--noconfirm", "-shell"] },
  ])
    expect(() =>
      parseAgentManifest(JSON.stringify({ ...codex, hostSetup: { install } }), "bundled"),
    ).toThrow("package-manager-only");
  expect(() =>
    parseAgentManifest(
      JSON.stringify({ ...codex, hostSetup: { signIn: { debian: ["sh", "-c", "id"] } } }),
      "bundled",
    ),
  ).toThrow("invalid-executable");
  for (const hostSetup of [
    { status: [] },
    { status: ["a".repeat(129)] },
    { install: { unknown: ["id"] } },
    { command: "id" },
  ])
    expect(() => parseAgentManifest(JSON.stringify({ ...codex, hostSetup }), "bundled")).toThrow();
});

test("only bundled manifests can declare HTTPS vendor scripts", () => {
  const script = { url: "https://vendor.test/install", interpreter: "sh", arguments: [] };
  const manifest = { ...codex, id: "fixture", hostSetup: { script } };
  expect(parseAgentManifest(JSON.stringify(manifest), "bundled").model.hostSetup?.script).toEqual(
    script,
  );
  expect(() => parseAgentManifest(JSON.stringify(manifest))).toThrow("bundled-only");
  for (const url of [
    "http://vendor.test/install",
    "https://user:pass@vendor.test/install",
    "https://vendor.test/#fragment",
    "invalid",
  ]) {
    expect(() =>
      parseAgentManifest(
        JSON.stringify({ ...manifest, hostSetup: { script: { ...script, url } } }),
        "bundled",
      ),
    ).toThrow("https-only");
  }
  expect(() =>
    parseAgentManifest(
      JSON.stringify({ ...manifest, hostSetup: { script: { ...script, interpreter: "custom" } } }),
      "bundled",
    ),
  ).toThrow();
});
