import { expect, test } from "vitest";
import { isReply } from "../../../../src/main/terminals/terminal-reports";

test("typed, pasted and control input is a reply", () => {
  for (const data of [
    "y",
    "\r",
    "\x03",
    "\x1b",
    "\x1b[A",
    "\x1b[200~pasted\x1b[201~",
    "\x1bOP",
    "\x1b]",
    "\x1bP",
    "\x1b[Iy",
    "y\x1b[O",
  ])
    expect(isReply(data), JSON.stringify(data)).toBe(true);
});

test("terminal-generated reports are not replies", () => {
  for (const data of [
    "",
    "\x1b[I",
    "\x1b[O",
    "\x1b[O\x1b[I",
    "\x1b[12;40R",
    "\x1b[?12;40R",
    "\x1b[?1;2c",
    "\x1b[>0;276;0c",
    "\x1b[?2004;1$y",
    "\x1b[0n",
    "\x1b[8;24;80t",
    "\x1b]11;rgb:0000/0000/0000\x1b\\",
    "\x1b]10;rgb:ffff/ffff/ffff\x07",
    "\x1bP1$r0m\x1b\\",
  ])
    expect(isReply(data), JSON.stringify(data)).toBe(false);
});

test("mouse presses are replies; releases, motion and the wheel are not", () => {
  expect(isReply("\x1b[<0;10;5M")).toBe(true);
  expect(isReply("\x1b[<0;10;5m")).toBe(false);
  expect(isReply("\x1b[<35;10;5M")).toBe(false);
  expect(isReply("\x1b[<64;10;5M")).toBe(false);
  // X10 encoding offsets each byte by 32.
  const x10 = (button: number) => `\x1b[M${String.fromCharCode(button + 32)}!!`;
  expect(isReply(x10(0))).toBe(true);
  expect(isReply(x10(3))).toBe(false);
  expect(isReply(x10(35))).toBe(false);
  expect(isReply(x10(64))).toBe(false);
  expect(isReply("\x1b[M")).toBe(true);
});
