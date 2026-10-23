import { expect, test, vi } from "vitest";
import type { ConfirmationWindowApi, DialogRequest } from "../../../src/shared/confirmation";
const mock = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: ConfirmationWindowApi) => void>(),
  on: vi.fn<(channel: string, listener: (event: unknown, value: unknown) => void) => void>(),
  send: vi.fn(),
}));
vi.mock("electron", () => ({ contextBridge: mock, ipcRenderer: mock }));
test("buffers main's request before React subscribes and exposes only rendering, size and answer", async () => {
  await import("../../../src/preload/confirmation");
  const api = mock.exposeInMainWorld.mock.calls[0]?.[1];
  if (!api) throw Error("Missing API");
  expect(Object.keys(api)).toEqual(["render", "size", "answer"]);
  const listener = mock.on.mock.calls[0]?.[1];
  const request = { id: "one" };
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
      checkingCount: 11,
      fetchedAt: 1000,
      progress: { items: [{ changes: "?? evidence.png\0" }, {}] },
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
    listener({}, invalid);
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
