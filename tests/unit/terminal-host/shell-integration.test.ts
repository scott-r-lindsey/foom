import { existsSync, readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import * as fs from "node:fs";
vi.mock("node:fs", { spy: true });
import { prepareShell } from "../../../src/terminal-host/shell-integration";

const spec = {
  command: "/bin/bash",
  args: ["-l"],
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  shellIntegration: true,
};

test("only explicitly opted-in Bash launches get private startup files and validated markers", () => {
  expect(prepareShell({ ...spec, shellIntegration: false })).toBeUndefined();
  expect(prepareShell({ ...spec, command: "zsh" })).toBeUndefined();
  const shell = prepareShell(spec);
  if (!shell) throw new Error("Missing shell integration");
  const file = shell.args[1];
  if (!file) throw new Error("Missing startup file");
  try {
    const script = readFileSync(file, "utf8");
    const token = /633;([a-f0-9-]+);prompt/.exec(script)?.[1];
    if (!token) throw new Error("Missing integration token");
    expect(shell.parse(`${token};running`)).toEqual({ phase: "running" });
    expect(shell.parse(`${token};prompt;0`)).toEqual({ phase: "prompt", exitCode: 0 });
    expect(shell.parse(`${token};prompt;255`)).toEqual({ phase: "prompt", exitCode: 255 });
    for (const marker of [
      "other;running",
      `${token};prompt;256`,
      `${token};prompt;-1`,
      `${token};prompt;0;exec`,
      `${token};prompt;`,
    ]) {
      expect(shell.parse(marker)).toBeUndefined();
    }
  } finally {
    shell.dispose();
  }
  expect(existsSync(file)).toBe(false);
});

test("cleans up startup files if writing fails", () => {
  const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  const remove = vi.spyOn(fs, "rmSync");
  try {
    expect(() => prepareShell(spec)).toThrow("disk full");
    expect(remove).toHaveBeenCalledWith(expect.stringContaining("foom-shell-"), {
      recursive: true,
      force: true,
    });
  } finally {
    write.mockRestore();
    remove.mockRestore();
  }
});
