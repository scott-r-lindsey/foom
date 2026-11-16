import { expect, it, vi } from "vitest";
import fs from "node:fs";
import { afterEach } from "vitest";
afterEach(() => vi.restoreAllMocks());
import { publishJson } from "../../helpers/publish-json.js";
it("publishes complete fleet fixture records while a concurrent reader observes replacement", () => {
  const state = { file: '{"pid":1}', temporary: "", observed: [] as number[] };
  vi.spyOn(fs, "writeFileSync").mockImplementation((_path, text) => {
    if (typeof text !== "string") throw new Error("Expected fixture JSON");
    state.temporary = text.slice(0, text.length / 2);
    const before: unknown = JSON.parse(state.file);
    if (
      typeof before !== "object" ||
      before === null ||
      !("pid" in before) ||
      typeof before.pid !== "number"
    )
      throw new Error("Invalid published JSON");
    state.observed.push(before.pid);
    state.temporary = text;
  });
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    state.file = state.temporary;
  });
  publishJson("fixture.json", { pid: 2, args: ["review"] });
  expect(state.observed).toEqual([1]);
  expect(JSON.parse(state.file)).toEqual({ pid: 2, args: ["review"] });
});
