import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as fsPromises from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const mock = vi.hoisted(() => ({ ps: vi.fn(), probe: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mock.ps }),
}));
vi.mock("../../../../src/terminal-host/remote/agent-discovery", () => ({ hostProbe: mock.probe }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof fsPromises>()),
}));
import { createHostPlatform } from "../../../../src/terminal-host/remote/host-platform";
import { linuxHostPlatform } from "../../../../src/terminal-host/remote/host-platform-linux";
let root: string;
let uid: number;
const executable = "/fixture/a directory/foom-host";
const started = "Thu Oct 29 21:00:00 2026";
const stat = (pid = "42", start = "123456", comm = "name with ) (spaces)") =>
  `${pid} (${comm}) S ${[...Array<string>(18).fill("0"), start, ...Array<string>(30).fill("0")].join(" ")}\n`;
async function processEntry(pid = "42", args = `${executable}\0--daemon\0`, text = stat(pid)) {
  const path = join(root, pid);
  await fs.mkdir(path, { recursive: true });
  await fs.writeFile(join(path, "stat"), text);
  await fs.writeFile(join(path, "cmdline"), args);
  return path;
}
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "host-platform-"));
  uid = (await fs.lstat(root)).uid;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
test("Linux reads bounded MemAvailable without spawning tools", async () => {
  const platform = linuxHostPlatform(root, uid);
  await fs.writeFile(join(root, "meminfo"), "MemFree: 1 kB\nMemAvailable: 1234 kB\n");
  expect(await platform.memoryAvailable()).toBe(1234 * 1024);
  for (const text of [
    "bad",
    "MemAvailable: -1 kB\n",
    "MemAvailable: 99999999999999999999 kB\n",
    "MemAvailable: 1 kB\nMemAvailable: 2 kB\n",
    "x".repeat(65537),
    Buffer.from([255]),
  ]) {
    await fs.writeFile(join(root, "meminfo"), text);
    await expect(platform.memoryAvailable()).rejects.toThrow();
  }
  expect(mock.ps).not.toHaveBeenCalled();
});
test("Linux matches exact NUL-delimited argv with spaces and retains start ticks", async () => {
  await processEntry();
  const platform = linuxHostPlatform(root, uid);
  expect(await platform.processIdentity(executable)).toEqual({ pid: 42, started: "123456" });
  for (const args of [
    `${executable} --daemon\0`,
    `${executable}\0--daemon\0extra\0`,
    `${executable}\0--daemon`,
    `${executable}\0--daemon\0\0`,
    "",
    `/other\0--daemon\0`,
  ]) {
    await fs.writeFile(join(root, "42", "cmdline"), args);
    expect(await platform.processIdentity(executable)).toBeUndefined();
  }
  expect(await linuxHostPlatform(root, uid + 1).processIdentity(executable)).toBeUndefined();
});
test("Linux skips vanished processes, non-process entries and unsafe PIDs", async () => {
  await processEntry("42");
  await fs.rm(join(root, "42", "cmdline"));
  await fs.mkdir(join(root, "1"));
  await fs.mkdir(join(root, "99999999999999999999999999"));
  await fs.writeFile(join(root, "43"), "not a directory");
  await fs.mkdir(join(root, "self"));
  expect(await linuxHostPlatform(root, uid).processIdentity(executable)).toBeUndefined();
});
test("Linux refuses malformed stat, oversized reads and duplicate matches", async () => {
  const directory = await processEntry();
  const platform = linuxHostPlatform(root, uid);
  for (const text of [
    "bad",
    stat("43"),
    stat("42", "-1"),
    stat("42", "01"),
    "42 (x) S 0\n",
    stat().replace(" S ", " ? "),
    Buffer.from([255]),
    "x".repeat(65537),
  ]) {
    await fs.writeFile(join(directory, "stat"), text);
    await expect(platform.processIdentity(executable)).rejects.toThrow();
  }
  await fs.writeFile(join(directory, "stat"), stat());
  await fs.writeFile(join(directory, "cmdline"), "x".repeat(262145));
  await expect(platform.processIdentity(executable)).rejects.toThrow("too large");
  await processEntry();
  await processEntry("43");
  await expect(platform.processIdentity(executable)).rejects.toThrow("identity unavailable");
});
test("Linux rechecks start time and owner after reading argv", async () => {
  await processEntry();
  const original = fs.open;
  let observations = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("/stat") && ++observations === 2)
      await fs.writeFile(join(root, "42", "stat"), stat("42", "987654"));
    return original(...args);
  });
  expect(await linuxHostPlatform(root, uid).processIdentity(executable)).toBeUndefined();
  vi.restoreAllMocks();
  const lstat = fs.lstat;
  let owners = 0;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const info = await lstat(...args);
    if (++owners === 2) info.uid = uid + 1;
    return info;
  });
  expect(await linuxHostPlatform(root, uid).processIdentity(executable)).toBeUndefined();
});
test("Linux propagates permission errors and cancellation without returning an identity", async () => {
  await processEntry();
  const cancellation = new AbortController();
  cancellation.abort();
  await expect(
    linuxHostPlatform(root, uid).processIdentity(executable, cancellation.signal),
  ).rejects.toThrow();
  await expect(linuxHostPlatform(root, uid).memoryAvailable(cancellation.signal)).rejects.toThrow();
  vi.spyOn(fs, "open").mockRejectedValueOnce(
    Object.assign(new Error("denied"), { code: "EACCES" }),
  );
  await expect(linuxHostPlatform(root, uid).processIdentity(executable)).rejects.toThrow("denied");
  vi.restoreAllMocks();
  const active = new AbortController();
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    active.abort();
    return lstat(...args);
  });
  await expect(
    linuxHostPlatform(root, uid).processIdentity(executable, active.signal),
  ).rejects.toThrow();
});
test("darwin retains fixed ps arguments, exact matches, errors and abort signal", async () => {
  const platform = createHostPlatform("darwin", root);
  const signal = new AbortController().signal;
  mock.ps.mockResolvedValue({ stdout: ` 42 ${started} ${executable} --daemon\n` });
  expect(await platform.processIdentity(executable, signal)).toEqual({ pid: 42, started });
  expect(mock.ps).toHaveBeenLastCalledWith(
    "/bin/ps",
    ["-ww", "-u", String(process.getuid?.() ?? -1), "-o", "pid=,lstart=,args="],
    expect.objectContaining({
      signal,
      timeout: 5000,
      maxBuffer: 262144,
      shell: false,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    }),
  );
  for (const stdout of [
    "bad",
    ` 1 ${started} ${executable} --daemon\n`,
    ` 9007199254740992 ${started} ${executable} --daemon\n`,
    ` 42 ${started} ${executable} --daemon extra\n`,
  ]) {
    mock.ps.mockResolvedValue({ stdout });
    expect(await platform.processIdentity(executable)).toBeUndefined();
  }
  mock.ps.mockResolvedValue({
    stdout: ` 42 ${started} ${executable} --daemon\n 43 ${started} ${executable} --daemon\n`,
  });
  await expect(platform.processIdentity(executable)).rejects.toThrow("identity unavailable");
  mock.ps.mockRejectedValueOnce(new Error("ps failed"));
  await expect(platform.processIdentity(executable)).rejects.toThrow("ps failed");
});
test("darwin uses captured vm_stat reclaimable page counts and the same deadline", async () => {
  const platform = createHostPlatform("darwin", root);
  const signal = new AbortController().signal;
  mock.probe.mockResolvedValue(
    "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 3.\nPages wired down: 900.\n",
  );
  expect(await platform.memoryAvailable(signal)).toBe(33 * 4096);
  expect(mock.probe).toHaveBeenLastCalledWith(
    "/usr/bin/vm_stat",
    [],
    root,
    undefined,
    false,
    5000,
    signal,
  );
  for (const output of ["bad", "page size of 4096 bytes\nPages free: 1.\n"]) {
    mock.probe.mockResolvedValue(output);
    await expect(platform.memoryAvailable()).rejects.toThrow("Memory unavailable");
  }
  // Both selections are independent of the runner OS.
  expect(createHostPlatform("linux")).toHaveProperty("processIdentity");
});

test("Linux observation deadline aborts a scan and closes its read handle", async () => {
  await processEntry();
  const original = fs.open;
  vi.useFakeTimers();
  const close = vi.fn();
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await original(...args);
    const originalClose = file.close.bind(file);
    vi.spyOn(file, "close").mockImplementation(async () => {
      close();
      await originalClose();
    });
    await vi.advanceTimersByTimeAsync(5000);
    return file;
  });
  try {
    await expect(linuxHostPlatform(root, uid).processIdentity(executable)).rejects.toThrow(
      "timed out",
    );
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("Linux refuses non-file observations", async () => {
  await fs.mkdir(join(root, "meminfo"));
  await expect(linuxHostPlatform(root, uid).memoryAvailable()).rejects.toThrow();
});

test("unsupported host platforms fail closed", async () => {
  const platform = createHostPlatform("win32", root);
  await expect(platform.memoryAvailable()).rejects.toThrow("Memory unavailable");
  await expect(platform.processIdentity(executable)).rejects.toThrow("identity unavailable");
});
