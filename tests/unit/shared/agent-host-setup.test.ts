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
