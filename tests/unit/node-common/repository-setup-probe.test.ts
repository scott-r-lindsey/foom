import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), groupKill: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { setupProbe } from "../../../src/node-common/repository-setup-probe";
const platform = process.platform;
let child: ReturnType<typeof fixtureChild>;
function fixtureChild() {
  return Object.assign(new EventEmitter(), {
    pid: 999999,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}
beforeEach(() => {
  child = fixtureChild();
  mocks.spawn.mockReturnValue(child);
  vi.spyOn(process, "kill").mockImplementation(() => {
    mocks.groupKill();
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: platform });
});
it("runs fixed argv outside a checkout and decodes only bounded successful output", async () => {
  const pending = setupProbe("/fixture/node", ["--version"], "/fixture/home", {
    PATH: "/fixture/bin",
  });
  child.stdout.write("v24.17.0\n");
  child.emit("exit", 0);
  child.emit("close", 0);
  expect(await pending).toBe("v24.17.0\n");
  expect(mocks.spawn.mock.calls[0]?.slice(0, 2)).toEqual(["/fixture/node", ["--version"]]);
});
it("keeps nonzero exits, invalid UTF-8 and spawn failures unknown", async () => {
  let pending = setupProbe("/fixture/query", [], "/fixture", {});
  child.emit("close", 1);
  await expect(pending).rejects.toMatchObject({ code: 1 });
  pending = setupProbe("/fixture/query", [], "/fixture", {});
  child.stdout.write(Buffer.from([0xff]));
  child.emit("close", 0);
  await expect(pending).rejects.toThrow("Invalid");
  pending = setupProbe("/fixture/query", [], "/fixture", {});
  child.emit("error", new Error("fixture missing"));
  child.emit("close", null);
  await expect(pending).rejects.toThrow("missing");
});
it.each(["stdout", "stderr"] as const)("bounds %s and kills the group", async (stream) => {
  const pending = setupProbe("/fixture/query", [], "/fixture", {});
  child[stream].write(Buffer.alloc(65537));
  child.emit("close", null);
  await expect(pending).rejects.toThrow("output exceeded");
  expect(mocks.groupKill).toHaveBeenCalled();
});
it("cancels and times out without holding a controlling terminal", async () => {
  const controller = new AbortController();
  let pending = setupProbe("/fixture/query", [], "/fixture", {}, controller.signal);
  controller.abort();
  child.emit("close", null);
  await expect(pending).rejects.toThrow("cancelled");
  expect(() => setupProbe("/fixture/query", [], "/fixture", {}, controller.signal)).toThrow();
  vi.useFakeTimers();
  pending = setupProbe("/fixture/query", [], "/fixture", {});
  vi.advanceTimersByTime(5000);
  child.emit("close", null);
  await expect(pending).rejects.toThrow("timed out");
});
it("uses native kill on Windows and tolerates already-gone groups", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const pending = setupProbe("/fixture/query", [], "/fixture", {});
  child.emit("exit", 0);
  child.emit("close", 0);
  await pending;
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("gone");
  });
  const gone = setupProbe("/fixture/query", [], "/fixture", {});
  child.emit("exit", 0);
  child.emit("close", 0);
  await gone;
});

it("ignores bounded stderr and handles a child with no assigned pid", async () => {
  Object.assign(child, { pid: undefined });
  const pending = setupProbe("/fixture/query", [], "/fixture", {});
  child.stderr.write("diagnostic");
  child.emit("exit", 0);
  child.emit("close", 0);
  expect(await pending).toBe("");
});
