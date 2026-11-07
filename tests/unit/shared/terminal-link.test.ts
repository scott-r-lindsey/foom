import { expect, test } from "vitest";
import { terminalLink, TERMINAL_LINK_LIMIT } from "../../../src/shared/terminal-link";

test("terminal URLs permit bounded HTTP(S) targets and reject unsafe schemes and presentation controls", () => {
  for (const value of [
    undefined,
    null,
    {},
    "",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "mailto:a@b.test",
    "not a URL",
    "https://" + "a".repeat(300) + ".test/",
    "https://example.com/\u0001",
    "https://example.com/\u007f",
    "https://example.com/\u0085",
    " https://example.com",
    "https://example.com/\npath",
    "https://example.com/\u202ecom",
    "https://example.com/\u2066path",
    "https://example.com/\u200fpath",
    "https://example.com/" + "a".repeat(TERMINAL_LINK_LIMIT),
  ])
    expect(terminalLink(value)).toBeUndefined();
  for (const value of [
    "http://localhost:3000/",
    "https://example.com/?a=b#c",
    "https://example.com/" + "a".repeat(2000),
    "https://example.com/" + "x".repeat(TERMINAL_LINK_LIMIT - 20),
  ])
    expect(terminalLink(value)).toBeInstanceOf(URL);
  for (const value of [
    "http://localhost:3000",
    "HTTPS://Example.com/Case",
    "https://bücher.example/",
    "https://good.example@evil.test/",
    "https://good.example%2Flogin@evil.test/",
    "https://user:password@evil.test/",
    "https://:password@evil.test/",
    "https://good.example\u2215login.evil.test/",
    "https://evil.test\\.good.example/",
    "https://good.example/\u200bpath",
    "https://good.example/\u00adpath",
    "https://good.example/\u034fpath",
  ])
    expect(terminalLink(value)).toBeUndefined();
});

test("OSC adapter refuses missing or incompatible xterm state and leaves target validation to the URL boundary", async () => {
  const { terminalOscId, terminalOscTarget } = await import("../../../src/shared/terminal-link");
  for (const value of [undefined, null, false]) expect(terminalOscId(value)).toBe(0);
  for (const value of [
    42,
    "cell",
    {},
    { extended: null },
    { extended: {} },
    { extended: { urlId: "1" } },
  ])
    expect(terminalOscId(value)).toBeUndefined();
  for (const extended of [undefined, null, {}, { urlId: "1" }])
    expect(terminalOscId({ hasExtendedAttrs: () => 1, extended })).toBeUndefined();
  expect(terminalOscId({ hasExtendedAttrs: () => 1 })).toBeUndefined();
  expect(terminalOscId({ hasExtendedAttrs: () => 1, extended: { urlId: 4 } })).toBe(4);
  expect(terminalOscId({ hasExtendedAttrs: () => 0, extended: { urlId: 4 } })).toBe(0);
  expect(terminalOscId({ hasExtendedAttrs: () => "bad", extended: { urlId: 4 } })).toBeUndefined();
  expect(terminalOscId({ extended: { urlId: 4 } })).toBeUndefined();
  for (const value of [
    undefined,
    42,
    {},
    { _core: null },
    { _core: 1 },
    { _core: {} },
    { _core: { _oscLinkService: null } },
    { _core: { _oscLinkService: {} } },
    { _core: { _oscLinkService: { getLinkData: "not callable" } } },
  ])
    expect(terminalOscTarget(value, 4)).toBeUndefined();
  for (const reply of [undefined, null, {}, { uri: 42 }, { uri: "javascript:alert(1)" }]) {
    const target = terminalOscTarget(
      { _core: { _oscLinkService: { getLinkData: () => reply } } },
      4,
    );
    expect(terminalLink(target)).toBeUndefined();
  }
});

test("Arabic letter mark is refused as a bidi presentation control", () => {
  expect(terminalLink("https://a.test/\u061cpath")).toBeUndefined();
});
