import { expect, test, vi } from "vitest";
const probe = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/terminal-host/remote/agent-discovery", () => ({ hostProbe: probe }));
import { remotePluginState } from "../../../../src/terminal-host/remote/plugin-status";
test("only a valid bounded absent inventory permits Install plugin; unknown inventories refuse", async () => {
  for (const [output, result] of [
    ["[]", "not-installed"],
    ['[{"name":"other","enabled":true}]', "not-installed"],
    ['[{"name":"foom","enabled":false}]', "present"],
    ["{}", "unavailable"],
    ["invalid", "unavailable"],
    ['[{"name":"foom"}]', "unavailable"],
    [
      JSON.stringify(Array.from({ length: 65 }, () => ({ name: "other", enabled: true }))),
      "unavailable",
    ],
  ]) {
    probe.mockResolvedValue(output);
    expect(await remotePluginState("/bin/agy", "/fixture", {})).toBe(result);
  }
  probe.mockRejectedValue(new Error("fixture"));
  expect(await remotePluginState("/bin/agy", "/fixture", {})).toBe("unavailable");
});
