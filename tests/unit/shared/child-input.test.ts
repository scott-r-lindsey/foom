import { expect, it } from "vitest";
import { CHILD_KEYS, childInputBytes, isChildInput } from "../../../src/shared/child-input";

it("validates bounded logical payloads and encodes all keys before writing", () => {
  for (const value of [
    null,
    1,
    [],
    {},
    { kind: "other", keys: ["y"] },
    { kind: "keys", keys: ["y"], extra: true },
    { kind: "keys", keys: Array(1) },
    { kind: "prompt", text: "\u2028" },
  ])
    expect(isChildInput(value)).toBe(false);
  expect(isChildInput({ kind: "prompt", text: "/continue\nnext\tline" })).toBe(true);
  expect(childInputBytes({ kind: "prompt", text: "hello\nworld" }, false)).toBe("hello\rworld\r");
  expect(childInputBytes({ kind: "prompt", text: "hello\nworld" }, true)).toBe(
    "\x1b[200~hello\rworld\x1b[201~\r",
  );
  for (const key of Object.keys(CHILD_KEYS)) {
    const input = { kind: "keys", keys: [key] };
    if (!isChildInput(input)) throw new Error("missing key");
    expect(childInputBytes(input, true)).toBe(CHILD_KEYS[input.keys[0] ?? "enter"]);
  }
  expect(() => childInputBytes({ kind: "prompt", text: "\x1b" }, false)).toThrow(
    "Invalid child input",
  );
});
