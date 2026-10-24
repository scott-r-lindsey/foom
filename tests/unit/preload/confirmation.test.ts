import { interfaceThemes } from "../../../src/shared/interface-themes";
import { malformedValues, withUndeclaredFields } from "./malformed-values";
import { dialog, theme } from "./preload-fixtures";
import { beforeEach, expect, test, vi } from "vitest";
import type { ConfirmationWindowApi, DialogRequest } from "../../../src/shared/confirmation";
const mock = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: ConfirmationWindowApi) => void>(),
  on: vi.fn<(channel: string, listener: (event: unknown, value: unknown) => void) => void>(),
  send: vi.fn(),
}));
vi.mock("electron", () => ({ contextBridge: mock, ipcRenderer: mock }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
test("buffers main's request before React subscribes and exposes only rendering, size and answer", async () => {
  await import("../../../src/preload/confirmation");
  const api = mock.exposeInMainWorld.mock.calls[0]?.[1];
  if (!api) throw Error("Missing API");
  expect(Object.keys(api)).toEqual(["render", "size", "answer"]);
  const listener = mock.on.mock.calls[0]?.[1];
  const request = { id: "one", theme, title: "Confirm", accept: "Continue" };
  listener?.({}, request);
  const render = vi.fn<(request: DialogRequest | null) => void>();
  const dispose = api.render(render);
  expect(render).toHaveBeenCalledWith(request);
  listener?.({}, null);
  expect(render).toHaveBeenLastCalledWith(null);
  api.size({ width: 440, height: 240 });
  expect(mock.send).toHaveBeenCalledWith("confirmation:size", { width: 440, height: 240 });
  api.answer("one", false);
  expect(mock.send).toHaveBeenCalledWith("confirmation:answer", "one", false);
  dispose();
  listener?.({}, request);
  expect(render).toHaveBeenCalledTimes(2);
});

test("rejects malformed structured fields and preserves literal data", async () => {
  vi.resetModules();
  await import("../../../src/preload/confirmation");
  const api = mock.exposeInMainWorld.mock.calls[0]?.[1];
  const listener = mock.on.mock.calls[0]?.[1];
  if (!api || !listener) throw Error("Missing confirmation bridge");
  const render = vi.fn();
  const dispose = api.render(render);
  const valid = {
    id: "structured",
    theme,
    title: "Confirm",
    accept: "Continue",
    subject: "<img src=x>",
    removals: [
      {
        id: "one",
        branch: "<img src=x>",
        path: "/trees/one",
        changes: "?? file\0",
        pullRequest: { number: 338, state: "MERGED" },
      },
    ],
    quiet: "Global config unchanged",
    cancel: "Not now",
    note: "Replacement",
    glyph: "link",
    arguments: ["--yolo"],
    sections: [
      {
        label: "It can",
        items: ["Create"],
        arguments: true,
        summary: [{ text: "1 file · 6 bytes", title: "Full text" }, { text: "Count" }],
      },
      { label: "Open", items: [] },
    ],
    facts: [
      { label: "Repository", value: "/repo", mono: true },
      { label: "Grants", value: "Read only" },
    ],
    pairing: { code: "ABCD1234", expiresAt: 1234 },
    cleanup: {
      stage: "ready",
      checkingCount: 11,
      fetchedAt: 1000,
      progress: {
        total: 2,
        done: 0,
        stopped: false,
        phase: "remove",
        items: [
          { id: "one", branch: "one", state: "queued", changes: "?? evidence.png\0" },
          { id: "two", branch: "two", state: "queued" },
        ],
      },
    },
  };
  listener({}, valid);
  expect(render).toHaveBeenLastCalledWith(valid);
  for (const invalid of [
    undefined,
    false,
    1,
    "text",
    { cancel: "Install now" },
    ...[-1, 1.5, Number.NaN, "7"].map((omittedChanges) => ({
      cleanup: { progress: { items: [{ omittedChanges }] } },
    })),
    { cleanup: { progress: { items: [{ changes: 42 }] } } },
    { cleanup: { progress: { items: [{ changes: "x".repeat(25_051) }] } } },
    { removals: {} },
    { removals: [null] },
    { removals: [{ id: "one", branch: "one", path: "/one", changes: 1 }] },
    ...[
      null,
      {},
      { number: 0, state: "OPEN" },
      { number: 1.5, state: "OPEN" },
      { number: 338, state: "unknown" },
      { number: "338", state: "OPEN" },
    ].map((pullRequest) => ({
      removals: [{ id: "one", branch: "one", path: "/one", changes: "", pullRequest }],
    })),
    { subject: 1 },
    { quiet: null },
    { note: [] },
    { glyph: "remote" },
    { arguments: "--yolo" },
    { arguments: [1] },
    { sections: {} },
    { sections: [null] },
    { sections: [{ label: 1, items: [] }] },
    { sections: [{ label: "Can", items: [1] }] },
    ...[
      null,
      false,
      "summary",
      [1],
      ["old string"],
      [null],
      [{ text: 1 }],
      [{ text: "row", title: 1 }],
      [{ title: "only" }],
    ].map((summary) => ({
      sections: [{ label: "Files", items: [], summary }],
    })),
    { sections: [{ label: "Files", items: [], arguments: "yes" }] },
    { facts: {} },
    { facts: [false] },
    { facts: [{ label: 1, value: "value" }] },
    { facts: [{ label: "Label", value: false }] },
    { facts: [{ label: "Label", value: "value", mono: 1 }] },
    { pairing: null },
    { pairing: { code: 1, expiresAt: 1234 } },
    { pairing: { code: "code", expiresAt: "1234" } },
    { pairing: { code: "code", expiresAt: Number.POSITIVE_INFINITY } },
    { cleanup: { checkingCount: -1 } },
    { cleanup: { fetchedAt: "bad" } },
    { cleanup: { fetchedAt: Number.NaN } },
  ]) {
    listener({}, typeof invalid === "object" ? { ...dialog, ...invalid } : invalid);
    expect(render).toHaveBeenLastCalledWith(null);
  }
  dispose();
});

test("bounds summary text and titles and rejects control and bidi characters", async () => {
  vi.resetModules();
  mock.exposeInMainWorld.mockClear();
  mock.on.mockClear();
  await import("../../../src/preload/confirmation");
  const api = mock.exposeInMainWorld.mock.calls[0]?.[1];
  const listener = mock.on.mock.calls[0]?.[1];
  if (!api || !listener) throw Error("Missing confirmation bridge");
  const render = vi.fn();
  const dispose = api.render(render);
  const request = (line: { text: string; title?: string }) => ({
    ...dialog,
    sections: [{ label: "Command", items: ["Full bytes\nremain reachable\0"], summary: [line] }],
  });
  const valid = request({ text: "·…🌌" + "x".repeat(8188), title: "x".repeat(8192) });
  listener({}, valid);
  expect(render).toHaveBeenLastCalledWith(valid);
  const controls = [
    "\0",
    "\n",
    "\r",
    "\t",
    "\u007f",
    "\u0085",
    "\u2028",
    "\u2029",
    ...Array.from({ length: 5 }, (_, i) => String.fromCodePoint(0x202a + i)),
    ...Array.from({ length: 4 }, (_, i) => String.fromCodePoint(0x2066 + i)),
    "\u200e",
    "\u200f",
  ];
  for (const field of ["text", "title"] as const) {
    for (const value of [
      ...controls.map((control) => `agy${control}exe`),
      "x".repeat(8193),
      "x".repeat(1024 * 1024),
    ]) {
      listener({}, request({ text: "safe", [field]: value }));
      expect(render).toHaveBeenLastCalledWith(null);
    }
  }
  dispose();
});

test("requires the complete dialog, including theme, cleanup, reply and session fields", async () => {
  vi.resetModules();
  mock.on.mockClear();
  mock.exposeInMainWorld.mockClear();
  await import("../../../src/preload/confirmation");
  const api = mock.exposeInMainWorld.mock.calls[0]?.[1];
  const listener = mock.on.mock.calls[0]?.[1];
  if (!api || !listener) throw Error("Missing confirmation bridge");
  const render = vi.fn();
  api.render(render);
  listener({}, dialog);
  expect(render).toHaveBeenLastCalledWith(dialog);
  for (const bad of malformedValues(dialog)) {
    listener({}, bad.value);
    expect(render, bad.path).toHaveBeenLastCalledWith(null);
  }
  for (const key of ["id", "theme", "title", "accept"]) {
    const missing = Object.fromEntries(Object.entries(dialog).filter(([name]) => name !== key));
    listener({}, missing);
    expect(render).toHaveBeenLastCalledWith(null);
  }
  for (const bad of [
    { id: "" },
    { title: "" },
    { accept: "" },
    { theme: {} },
    { cleanup: null },
    { cleanup: {} },
    { cleanup: { ...dialog.cleanup, stage: "unknown" } },
    { theme: { ...theme, base: "unknown" } },
    { theme: { ...theme, version: 3 } },
  ]) {
    listener({}, { ...dialog, ...bad });
    expect(render).toHaveBeenLastCalledWith(null);
  }
  listener(
    {},
    {
      id: "minimal",
      theme: interfaceThemes["eclipse-light"],
      title: "Confirm",
      accept: "Continue",
    },
  );
  expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ id: "minimal" }));
});

test("publishes only validated confirmation fields, including buffered and live nested content", async () => {
  await import("../../../src/preload/confirmation");
  const api = mock.exposeInMainWorld.mock.calls[0]?.[1];
  const listener = mock.on.mock.calls[0]?.[1];
  if (!api || !listener) throw Error("Missing confirmation bridge");
  const injected = withUndeclaredFields(dialog);
  listener({}, injected);
  const render = vi.fn<(request: DialogRequest | null) => void>();
  api.render(render);
  expect(render).toHaveBeenLastCalledWith(dialog);
  const published = render.mock.lastCall?.[0];
  expect(published).toStrictEqual(dialog);
  expect(published).not.toBe(injected);
  expect(Object.getPrototypeOf(published)).toBe(Object.prototype);
  expect(Object.hasOwn(published ?? {}, "__proto__")).toBe(false);
  listener({}, { ...dialog, worktrees: [{ branch: "merged-branch", changes: {} }] });
  expect(render).toHaveBeenLastCalledWith({ ...dialog, worktrees: [{ branch: "merged-branch" }] });
  listener({}, { ...dialog, worktrees: [{ branch: "merged-branch", reason: {} }] });
  expect(render).toHaveBeenLastCalledWith(null);
});

test("rebuilds size and selection payloads and drops malformed confirmation answers", async () => {
  await import("../../../src/preload/confirmation");
  const api = mock.exposeInMainWorld.mock.calls[0]?.[1];
  if (!api) throw Error("Missing confirmation bridge");
  const size = { width: 440, height: 240, unexpected: { changes: {} }, ["__proto__"]: {} };
  api.size(size);
  expect(mock.send.mock.lastCall).toStrictEqual(["confirmation:size", { width: 440, height: 240 }]);
  const selected = ["one", "two"];
  Object.defineProperty(selected, "unexpected", { value: {}, enumerable: true });
  api.answer("request", selected);
  expect(mock.send.mock.lastCall).toStrictEqual(["confirmation:answer", "request", ["one", "two"]]);
  expect(mock.send.mock.lastCall?.[2]).not.toBe(selected);
  mock.send.mockClear();
  for (const value of [0, -1, NaN, Infinity]) {
    api.size({ width: value, height: 240 });
    api.size({ width: 440, height: value });
  }
  api.answer("", true);
  for (const selected of [[], [""], ["one", "one"]]) api.answer("request", selected);
  expect(mock.send).not.toHaveBeenCalled();
});
