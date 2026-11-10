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

function installer(environment: unknown) {
  return parseAgentManifest(
    JSON.stringify({ ...codex, hostSetup: { script: { ...codex.hostSetup.script, environment } } }),
    "bundled",
  ).model.hostSetup?.script?.environment;
}
test("installer environment accepts bounded fixed literal pairs", () => {
  const environment = [
    { name: "CODEX_NON_INTERACTIVE", value: "1" },
    { name: "_vendor_mode2", value: "fixed value" },
  ];
  expect(installer(environment)).toEqual(environment);
  expect(installer([])).toEqual([]);
  expect(
    installer(
      Array.from({ length: 8 }, (_, i) => ({
        name: `VENDOR_${String(i)}`,
        value: "a".repeat(128),
      })),
    ),
  ).toHaveLength(8);
});
test("installer environment rejects reserved and invalid names regardless of case", () => {
  for (const name of [
    "FOOM_TOKEN",
    "foom_settings_install",
    "FoOm_TEST",
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "XDG_CONFIG_HOME",
    "xdg_other",
    "home",
    "Path",
    "user",
    "logname",
    "shell",
    "tmpdir",
    "lang",
    "",
    "1MODE",
    "BAD-NAME",
    "BAD=NAME",
    "A".repeat(65),
  ])
    expect(() => installer([{ name, value: "1" }]), name).toThrow();
});
test("installer environment rejects references, templates, nonstrings and malformed or excessive entries", () => {
  for (const value of [
    "$HOME",
    "$(id)",
    "`id`",
    "%HOME%",
    "{home}",
    "{file:config}",
    "x\ny",
    "x\0y",
    "",
    "a".repeat(129),
    true,
    1,
    null,
    ["1"],
    { literal: "1" },
  ])
    expect(() => installer([{ name: "VENDOR_MODE", value }]), JSON.stringify(value)).toThrow();
  for (const environment of [
    null,
    {},
    "MODE=1",
    [null],
    [{ name: "MODE" }],
    [{ value: "1" }],
    [{ name: "MODE", value: "1", when: {} }],
    Array.from({ length: 9 }, () => ({ name: "MODE", value: "1" })),
  ])
    expect(() => installer(environment)).toThrow();
});
