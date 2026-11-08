import { expect, test } from "vitest";
import { terminalClipboardText } from "../../../src/shared/terminal-clipboard";

test("OSC 52 accepts only bounded canonical UTF-8 clipboard writes", () => {
  for (const text of ["", "hello", "🔒 café\n", "\uFEFFbom", "x".repeat(65_536)]) {
    const base64 = Buffer.from(text).toString("base64");
    for (const target of ["", "c"]) {
      expect(terminalClipboardText(`${target};${base64}`)).toBe(text);
      expect(terminalClipboardText(`${target};${base64.replace(/=+$/u, "")}`)).toBe(text);
    }
  }
  for (const value of [
    null,
    {},
    1,
    "c",
    "c;?",
    ";?",
    "p;aGk=",
    "cp;aGk=",
    "s;aGk=",
    "c;!",
    "c;a",
    "c;ab==",
    "c;abc===",
    "c;aG k=",
    "c;====",
    "c;/w==",
    "c;wK8=",
    "c;7aCA",
    `c;${Buffer.from("x".repeat(65_537)).toString("base64")}`,
  ]) {
    expect(terminalClipboardText(value)).toBeUndefined();
  }
});
