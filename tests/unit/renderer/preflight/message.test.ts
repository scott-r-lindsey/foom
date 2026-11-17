import { expect, test } from "vitest";
import { message } from "../../../../src/renderer/preflight/message";
import { copyableErrorId } from "../../../../src/shared/application-errors";

test.each([
  ["settings-busy", "Settings are busy; try again."],
  [
    "settings-lock-corrupt",
    "Quit other Foom windows, then remove .foom-settings.lock and its recovery locks.",
  ],
  ["settings-lock-unsupported", "The config filesystem does not support hard links."],
])("settings message %s is fixed and copyable", (code, text) => {
  expect(message(new Error(`foom-error:${code}`))).toBe(text);
  expect(
    message(new Error(`Error invoking remote method 'setup:save': Error: foom-error:${code}`)),
  ).toBe(text);
  expect(copyableErrorId(text)).toBe(code);
  expect(message(new Error(`foom-error:${code}:/untrusted/path`))).toBe(
    "Unable to update settings.",
  );
});

test("unknown settings failures never display exception text", () => {
  expect(message(new Error("private /path"))).toBe("Unable to update settings.");
  expect(message(null)).toBe("Unable to update settings.");
});
