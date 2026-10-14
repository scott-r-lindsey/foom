import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ error: false, execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mock.execFile }));
import { fontCommand, parseFontOutput } from "../../../../src/main/fonts/terminal-fonts";

import type { listTerminalFonts as ListTerminalFonts } from "../../../../src/main/fonts/terminal-fonts";
let listTerminalFonts: typeof ListTerminalFonts;
beforeEach(async () => {
  vi.resetModules();
  mock.execFile.mockReset();
  mock.error = false;
  vi.spyOn(Date, "now").mockReturnValue(100_000);
  ({ listTerminalFonts } = await import("../../../../src/main/fonts/terminal-fonts"));
});
afterEach(() => vi.restoreAllMocks());

test("parses platform line output and rejects CSS, blank and control-bearing names", () => {
  expect(
    parseFontOutput('Mono B\r\nMono A\nMono B\nHack Nerd Font Mono\nx",serif\na\tb\n'),
  ).toEqual(["Mono A", "Mono B"]);
});

test("platform commands have fixed scripts and arguments and no shell", () => {
  expect(fontCommand("linux")).toEqual([
    "/usr/bin/fc-list",
    [":spacing=100", "--format=%{family[0]}\\n"],
  ]);
  expect(fontCommand("darwin")?.[1].join(" ")).toContain("font.isFixedPitch");
  expect(fontCommand("win32")?.[1].join(" ")).toContain("AdvanceWidths");
  expect(fontCommand("freebsd")).toBeNull();
});

test("enumeration is bounded, validated and tolerates a missing tool or platform", async () => {
  const platform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    mock.execFile.mockImplementation(
      (
        _file: unknown,
        _args: unknown,
        _options: unknown,
        callback: (error: Error | null, output: string) => void,
      ) => {
        callback(mock.error ? new Error("tool missing") : null, "Mono\nMono\nbad;\n");
      },
    );
    await expect(listTerminalFonts()).resolves.toEqual(["Mono"]);
    expect(mock.execFile).toHaveBeenCalledWith(
      "/usr/bin/fc-list",
      [":spacing=100", "--format=%{family[0]}\\n"],
      { encoding: "utf8", timeout: 10000, maxBuffer: 1048576, windowsHide: true },
      expect.any(Function),
    );
    mock.error = true;
    vi.mocked(Date.now).mockReturnValue(130_000);
    await expect(listTerminalFonts(true)).resolves.toEqual(["Mono"]);
    Object.defineProperty(process, "platform", { value: "freebsd" });
    await expect(listTerminalFonts(true)).resolves.toEqual(["Mono"]);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    mock.error = false;
  }
});

function pendingEnumeration() {
  let finish: (error: Error | null, output: string) => void = () => {
    throw new Error("Enumeration has not started");
  };
  mock.execFile.mockImplementation(
    (
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (error: Error | null, output: string) => void,
    ) => {
      finish = callback;
    },
  );
  return (output: string, error: Error | null = null) => {
    finish(error, output);
  };
}

test("concurrent cold requests share one process and a second open reads the cache", async () => {
  const finish = pendingEnumeration();
  const first = listTerminalFonts();
  const second = listTerminalFonts();
  const refresh = listTerminalFonts(true);
  expect(mock.execFile).toHaveBeenCalledOnce();
  finish("Mono A\n");
  expect(await Promise.all([first, second, refresh])).toEqual([["Mono A"], ["Mono A"], ["Mono A"]]);
  await expect(listTerminalFonts()).resolves.toEqual(["Mono A"]);
  await expect(listTerminalFonts(true)).resolves.toEqual(["Mono A"]);
  expect(mock.execFile).toHaveBeenCalledOnce();
});

test("refresh shares its process, leaves cached reads immediate, and publishes new families", async () => {
  const finish = pendingEnumeration();
  const first = listTerminalFonts();
  finish("Mono A\n");
  await first;
  vi.mocked(Date.now).mockReturnValue(130_000);
  const refresh = listTerminalFonts(true);
  const concurrent = listTerminalFonts(true);
  await expect(listTerminalFonts()).resolves.toEqual(["Mono A"]);
  expect(mock.execFile).toHaveBeenCalledTimes(2);
  finish("Mono B\nMono A\n");
  expect(await Promise.all([refresh, concurrent])).toEqual([
    ["Mono A", "Mono B"],
    ["Mono A", "Mono B"],
  ]);
  await expect(listTerminalFonts()).resolves.toEqual(["Mono A", "Mono B"]);
  await expect(listTerminalFonts(true)).resolves.toEqual(["Mono A", "Mono B"]);
  expect(mock.execFile).toHaveBeenCalledTimes(2);
});

test("cold failures are retryable, successful empty lists are cached, and failed refreshes preserve the cache", async () => {
  const finish = pendingEnumeration();
  const failed = listTerminalFonts();
  finish("", new Error("tool missing"));
  await expect(failed).resolves.toEqual([]);
  const retry = listTerminalFonts();
  expect(mock.execFile).toHaveBeenCalledTimes(2);
  finish("");
  await expect(retry).resolves.toEqual([]);
  await expect(listTerminalFonts()).resolves.toEqual([]);
  expect(mock.execFile).toHaveBeenCalledTimes(2);
  vi.mocked(Date.now).mockReturnValue(130_000);
  const refresh = listTerminalFonts(true);
  finish("", new Error("refresh failed"));
  await expect(refresh).resolves.toEqual([]);
  const retryRefresh = listTerminalFonts(true);
  expect(mock.execFile).toHaveBeenCalledTimes(4);
  finish("New Mono");
  await expect(retryRefresh).resolves.toEqual(["New Mono"]);
});

test("unsupported platforms leave the default usable without spawning a process", async () => {
  const platform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "freebsd" });
    await expect(listTerminalFonts()).resolves.toEqual([]);
    expect(mock.execFile).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
  }
});

test("a synchronous launch failure is retryable", async () => {
  mock.execFile.mockImplementationOnce(() => {
    throw new Error("launch failed");
  });
  await expect(listTerminalFonts()).resolves.toEqual([]);
  const finish = pendingEnumeration();
  const retry = listTerminalFonts();
  finish("Recovered Mono");
  await expect(retry).resolves.toEqual(["Recovered Mono"]);
});
