import { afterEach, expect, test, vi } from "vitest";
import { ForegroundProgram } from "../../../src/terminal-host/foreground-program";
import { foregroundName } from "../../../src/shared/foreground-name";
import { hostResponse } from "../../../src/shared/terminal-host-protocol";
afterEach(() => {
  vi.useRealTimers();
});
test("foreground names reject paths, arguments, controls and untrusted payloads and bound the display", () => {
  for (const value of [null, 4, {}, "vim file", "/bin/vim", "a\\b", "a\n", "\x1b[31m", "a\u202eb"])
    expect(foregroundName(value)).toBe("");
  expect(foregroundName("vim")).toBe("vim");
  expect(foregroundName("a".repeat(80))).toHaveLength(32);
  for (const name of ["", "vim", "a".repeat(32)])
    expect(hostResponse({ type: "foreground", id: "id", name })).toBe(true);
  for (const name of [null, "vim file", "a".repeat(33)])
    expect(hostResponse({ type: "foreground", id: "id", name })).toBe(false);
});
test("output lookups are capped, lifecycle start catches silent programs and prompt cancels pending work", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const read = vi.fn(() => "bash"),
    publish = vi.fn();
  const program = new ForegroundProgram("/bin/bash", read, publish, "linux");
  program.refresh(0);
  expect(publish).not.toHaveBeenCalled();
  read.mockReturnValue("/usr/bin/npm");
  program.refresh(999);
  expect(read).toHaveBeenCalledTimes(1);
  program.refresh(1000);
  expect(publish).toHaveBeenLastCalledWith("npm");
  program.refresh(2000);
  expect(publish).toHaveBeenCalledTimes(1);
  program.refresh(2001, { phase: "prompt", exitCode: 0 });
  expect(publish).toHaveBeenLastCalledWith("");
  read.mockReturnValue("bash");
  program.refresh(2002, { phase: "running" });
  read.mockReturnValue("sleep");
  vi.advanceTimersByTime(100);
  expect(publish).toHaveBeenLastCalledWith("sleep");
  const calls = read.mock.calls.length;
  vi.advanceTimersByTime(10000);
  expect(read).toHaveBeenCalledTimes(calls);
  program.refresh(20000, { phase: "running" });
  program.refresh(20001, { phase: "prompt", exitCode: 0 });
  expect(vi.getTimerCount()).toBe(0);
  read.mockImplementation(() => {
    throw new Error("exited");
  });
  program.refresh(22000);
  program.refresh(22001, { phase: "running" });
  program.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
test("ConPTY never queries a foreground name", () => {
  const read = vi.fn(),
    publish = vi.fn();
  new ForegroundProgram("cmd.exe", read, publish, "win32").refresh(0, { phase: "running" });
  expect(read).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

test("unintegrated shells coalesce final prompt output into one trailing refresh and then stop", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const read = vi.fn(() => "vim"),
    publish = vi.fn();
  const program = new ForegroundProgram("/bin/zsh", read, publish, "darwin");
  program.refresh(Date.now());
  expect(publish).toHaveBeenLastCalledWith("vim");
  vi.advanceTimersByTime(100);
  read.mockReturnValue("zsh");
  program.refresh(Date.now());
  program.refresh(Date.now());
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(900);
  expect(publish).toHaveBeenLastCalledWith("");
  expect(read).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(10000);
  expect(read).toHaveBeenCalledTimes(2);
  program.refresh(Date.now());
  vi.advanceTimersByTime(100);
  program.refresh(Date.now());
  program.dispose();
  vi.advanceTimersByTime(1000);
  expect(read).toHaveBeenCalledTimes(3);
});
