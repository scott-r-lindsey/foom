import { expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ error: false, execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mock.execFile }));
import {
  fontCommand,
  listTerminalFonts,
  parseFontOutput,
} from "../../../../src/main/fonts/terminal-fonts";

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
    await expect(listTerminalFonts()).resolves.toEqual([]);
    Object.defineProperty(process, "platform", { value: "freebsd" });
    await expect(listTerminalFonts()).resolves.toEqual([]);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    mock.error = false;
  }
});
