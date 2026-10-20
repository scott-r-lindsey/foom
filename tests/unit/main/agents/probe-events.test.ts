import { expect, test } from "vitest";
import { probeHookEvent } from "../../../../src/main/agents/probe-events";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import fixture from "../../../fixtures/agent-plugins-v2/copilot.json";
const channel = parseAgentManifest(JSON.stringify(fixture)).model.hooks?.channels[0];
if (!channel) throw Error("Missing fixture channel");
test("retains only safe field paths, extracted event and match facts without values", () => {
  const value = {
    session_id: "expected",
    hook_event_name: "Stop",
    secret: "PRIVATE",
    object: { nested: [{ fourth: { fifth: "PRIVATE" } }] },
    "bad.key": "PRIVATE",
    "bad\nkey": "PRIVATE",
    ["x".repeat(65)]: "PRIVATE",
  };
  const event = probeHookEvent(channel, value, undefined, undefined, "expected", {
    terminalId: "id",
    action: "classify",
    signal: "plugin:fixture:stop",
    caseId: "stop",
  });
  expect(event).toEqual({
    channel: "lifecycle",
    event: "Stop",
    caseId: "stop",
    paths: [
      "session_id",
      "hook_event_name",
      "secret",
      "object",
      "object.nested",
      "object.nested.0",
      "object.nested.0.fourth",
    ],
    sessionMatchesNewId: true,
  });
  expect(JSON.stringify(event)).not.toContain("PRIVATE");
  expect(
    probeHookEvent(
      channel,
      { hook_event_name: "secret text\n" },
      undefined,
      undefined,
      undefined,
      undefined,
    ),
  ).toMatchObject({ event: null, caseId: null, sessionMatchesNewId: false });
  expect(probeHookEvent(channel, null, undefined, undefined, "expected", undefined).paths).toEqual(
    [],
  );
  expect(
    probeHookEvent(channel, { session_id: "foreign" }, undefined, undefined, "expected", undefined)
      .sessionMatchesNewId,
  ).toBe(false);
});
test("bounds path count, depth and length even with hostile wide and deep JSON", () => {
  expect(
    probeHookEvent(
      channel,
      Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field${String(i)}`, "secret"])),
      undefined,
      undefined,
      undefined,
      undefined,
    ).paths,
  ).toHaveLength(128);
  const key = "a".repeat(64);
  const paths = probeHookEvent(
    channel,
    { [key]: { [key]: { [key]: { [key]: "secret" } } } },
    undefined,
    undefined,
    undefined,
    undefined,
  ).paths;
  expect(paths).toHaveLength(3);
  expect(paths.every((path) => path.length <= 256)).toBe(true);
});
