import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow } from "electron";

const mock = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
  removeHandler: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: mock.handle, removeHandler: mock.removeHandler },
}));
import { attachEnvironment } from "../../../../src/main/setup/environment-ipc";
import { EnvironmentStore } from "../../../../src/main/setup/environment";

const frame = { url: "app://bundle/index.html" };
const contents = { mainFrame: frame };
const window = { webContents: contents } as unknown as BrowserWindow;
const trusted = { sender: contents, senderFrame: frame };
const cipher = {
  available: () => true,
  encrypt: (text: string) => Buffer.from(`enc:${text}`).reverse(),
  decrypt: (data: Buffer) => Buffer.from(data).reverse().toString().slice(4),
};
let dir: string;
let changed: ReturnType<typeof vi.fn<() => void>>;
let attached: ReturnType<typeof attachEnvironment>;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await mkdtemp(path.join(os.tmpdir(), "foom-environment-ipc-"));
  changed = vi.fn<() => void>();
  const store = await EnvironmentStore.open(dir, cipher, {
    windows: false,
    read: () => Promise.resolve({ HTTPS_PROXY: "http://me:pw@proxy:8080", PATH: "/x" }),
  });
  attached = attachEnvironment(window, store, changed);
});
afterEach(async () => {
  attached.dispose();
  await rm(dir, { recursive: true, force: true });
});

function invoke(channel: string, args: unknown[] = [], event: unknown = trusted): unknown {
  const handler = mock.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (!handler) throw new Error(`Missing ${channel}`);
  return handler(event, ...args);
}

test("every channel rejects untrusted senders and frames", () => {
  const channels = mock.handle.mock.calls.map(([name]) => name);
  expect(channels).toEqual([
    "environment:state",
    "environment:save",
    "environment:remove",
    "environment:read-shell",
    "environment:import",
  ]);
  for (const channel of channels)
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { url: frame.url } },
      { sender: contents, senderFrame: null },
    ])
      expect(() => invoke(channel, [], event)).toThrow("Untrusted IPC sender");
  attached.dispose();
  expect(mock.removeHandler.mock.calls.map(([name]: unknown[]) => name)).toEqual(channels);
});

test("payloads sent straight over IPC are validated in main with a reason", async () => {
  const save = (change: unknown) => invoke("environment:save", [change]);
  const row = { scope: "all", previous: null, value: "x", secret: false };
  await expect(save({ ...row, name: "FOOM_TOKEN" })).rejects.toThrow(
    "FOOM_TOKEN is reserved by Foom",
  );
  await expect(save({ ...row, name: "claudecode" })).rejects.toThrow("reserved by Foom");
  await expect(save({ ...row, name: "LD_PRELOAD" })).rejects.toThrow(
    "LD_PRELOAD can't be set: it loads code into every process",
  );
  await expect(save({ ...row, name: "1BAD" })).rejects.toThrow("Names use letters");
  await expect(save({ ...row, scope: "shell", name: "A" })).rejects.toThrow(
    "Invalid environment list",
  );
  await expect(save({ ...row, name: "A", extra: true })).rejects.toThrow("Invalid environment");
  await expect(save({ ...row, name: "A", secret: "yes" })).rejects.toThrow("Invalid environment");
  await expect(save(null)).rejects.toThrow("Invalid environment");
  await expect(invoke("environment:remove", ["all", 7])).rejects.toThrow("Invalid environment");
  await expect(invoke("environment:import", ["HTTPS_PROXY"])).rejects.toThrow("Invalid import");
  expect(changed).not.toHaveBeenCalled();
  await expect(readFile(path.join(dir, "environment.json"), "utf8")).rejects.toThrow();
});

test("replies mask secrets and changes refresh redaction", async () => {
  const state = await invoke("environment:save", [
    { scope: "claude", previous: null, name: "TOKEN", value: "s3cret-value", secret: true },
  ]);
  expect(state).toMatchObject({
    lists: { claude: [{ name: "TOKEN", value: null, secret: true }] },
  });
  expect(JSON.stringify(state)).not.toContain("s3cret-value");
  expect(changed).toHaveBeenCalledOnce();
  const candidates = await invoke("environment:read-shell");
  expect(candidates).toEqual([
    { name: "HTTPS_PROXY", display: "http://me:••••@proxy:8080", status: "new" },
  ]);
  const imported = await invoke("environment:import", [["HTTPS_PROXY"]]);
  expect(JSON.stringify(imported)).not.toContain("pw@");
  expect(await invoke("environment:remove", ["claude", "TOKEN"])).toMatchObject({
    lists: { claude: [] },
  });
  expect(changed).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(await invoke("environment:state"))).not.toContain("pw@");
});
