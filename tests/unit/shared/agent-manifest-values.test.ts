import { expect, it } from "vitest";
import * as values from "../../../src/shared/agent-manifest-values";
import { manifestJson } from "../../../src/shared/agent-manifest-json";
import {
  dataContainer,
  tomlContainer,
  validateCommandSlots,
} from "../../../src/shared/agent-manifest-container";
import { implies } from "../../../src/shared/agent-manifest-templates";
it("validates each primitive at its boundaries", () => {
  expect(values.text("a".repeat(4096), "$")).toHaveLength(4096);
  for (const v of [
    "",
    0,
    null,
    "a".repeat(4097),
    "\n",
    "\t",
    "\u202e",
    "\u200b",
    "\ue000",
    "\ud800",
    "\u2028",
    "\u2029",
  ])
    expect(() => values.text(v, "$")).toThrow();
  expect(values.id("a".repeat(40), "$")).toHaveLength(40);
  for (const v of ["A", "1a", "a_b", "a".repeat(41)]) expect(() => values.id(v, "$")).toThrow();
  expect(values.localId("a_B-0", "$")).toBe("a_B-0");
  expect(values.flag("-a", "$")).toBe("-a");
  for (const v of ["a", "---a", "--", "-0"]) expect(() => values.flag(v, "$")).toThrow();
  for (const v of ["a.cmd", "a.BAT", "a.ps1", "a/b", "a".repeat(65)])
    expect(() => values.basename(v, "$")).toThrow();
  expect(values.basename("a.exe", "$")).toBe("a.exe");
  expect(values.relative("a/b/c/d", "$")).toBe("a/b/c/d");
  expect(values.relative(".a/b/c/d/e", "$", true)).toBe(".a/b/c/d/e");
  for (const v of [
    "/a",
    "a//b",
    ".",
    "..",
    "a/../b",
    "C:/a",
    "a\\b",
    ".hidden",
    "a/b/c/d/e",
    "a".repeat(101),
  ])
    expect(() => values.relative(v, "$")).toThrow();
  for (const v of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1, "1", null])
    expect(() => values.integer(v, "$")).toThrow();
  expect(values.integer(Number.MAX_SAFE_INTEGER, "$")).toBe(Number.MAX_SAFE_INTEGER);
  expect(values.integer(1, "$", 1, 1)).toBe(1);
  expect(() => values.integer(2, "$", 1, 1)).toThrow();
  expect(() => values.integer(0, "$", 1, 1)).toThrow();
  expect(values.boolean(false, "$")).toBe(false);
  expect(() => values.boolean(0, "$")).toThrow();
  expect(values.literal(1)(1, "$")).toBe(1);
  expect(() => values.literal(1)(2, "$")).toThrow();
  expect(values.enumeration("a", "b")("b", "$")).toBe("b");
  expect(() => values.enumeration("a")("b", "$")).toThrow();
  expect(values.array(values.text, 2, 1)(["a", "b"], "$")).toEqual(["a", "b"]);
  for (const v of [[], ["a", "b", "c"], 0])
    expect(() => values.array(values.text, 2, 1)(v, "$")).toThrow();
  expect(values.optional(values.text)(undefined, "$")).toBeUndefined();
  expect(values.optional(values.text)("a", "$")).toBe("a");
  expect(values.defaulted(values.text, "b")(undefined, "$")).toBe("b");
  expect(values.defaulted(values.text, "b")("a", "$")).toBe("a");
  expect(values.unique(["a", "b"], "$")).toEqual(["a", "b"]);
  expect(() => values.unique(["a", "a"], "$")).toThrow("duplicate-id");
  for (const v of [null, false, 2, "a"]) expect(values.primitive(v, "$")).toBe(v);
  expect(() => values.primitive(Infinity, "$")).toThrow();
  expect(() => values.primitive({}, "$")).toThrow();
  expect(values.multiline("\n\t".repeat(8192), "$")).toHaveLength(16384);
  for (const v of [1, "a".repeat(16385), "\r", "\u200b", "\ud800"])
    expect(() => values.multiline(v, "$")).toThrow();
  expect(values.versionText("\n".repeat(256), "$")).toHaveLength(256);
  expect(values.versionText("", "$")).toBe("");
  for (const v of [1, "a".repeat(257), "\t"]) expect(() => values.versionText(v, "$")).toThrow();
  for (const v of [null, [], 1]) expect(() => values.object(v, "$", [])).toThrow();
  expect(() => values.object({ bad: 1 }, "$", [])).toThrow("unknown-key");
  expect(() => values.object({}, "$", ["name"])).toThrow("missing-key");
});
it("bounds JSON before recursion and preserves decoded duplicate and unsafe keys", () => {
  expect(manifestJson('{"a":[1,true,false,null,"x\\u0061"]}')).toEqual({
    a: [1, true, false, null, "xa"],
  });
  expect(manifestJson(" [ ] ")).toEqual([]);
  expect(manifestJson("{}")).toEqual({});
  for (const source of [
    '{"a":1,"\\u0061":2}',
    '{"__proto__":1}',
    '{"constructor":1}',
    '{"prototype":1}',
  ])
    expect(() => manifestJson(source)).toThrow(/duplicate-key|unsafe-key/u);
  for (const source of [
    "",
    "{",
    "[",
    "{1:0}",
    "[1,]",
    '{"a":1,}',
    '"a\n"',
    "01",
    "true false",
    "\ufeff{}",
    "1e999",
  ])
    expect(() => manifestJson(source)).toThrow();
  expect(manifestJson(" ".repeat(65534) + "{}")).toEqual({});
  expect(() => manifestJson(" ".repeat(65535) + "{}")).toThrow("too-large");
  expect(() => manifestJson("[".repeat(24) + "0" + "]".repeat(24))).toThrow("too-deep");
  expect(manifestJson("[".repeat(23) + "0" + "]".repeat(23))).toBeDefined();
  expect(manifestJson("[" + Array(8191).fill("0").join(",") + "]")).toBeDefined();
  expect(() => manifestJson("[" + Array(8192).fill("0").join(",") + "]")).toThrow("too-many-nodes");
});
it("parses bounded data-only TOML and validates generic executable slots", () => {
  expect(
    tomlContainer(
      '# hi\n[a.b]\nkey = [true, false, 2.5, "x", \'y\']\n[a.c]\n"quoted" = { nested.key = "z" }',
      "$",
    ),
  ).toEqual({
    a: { b: { key: [true, false, 2.5, "x", "y"] }, c: { quoted: { nested: { key: "z" } } } },
  });
  expect(tomlContainer("[1, 2,]", "$")).toEqual([1, 2]);
  expect(tomlContainer("{}", "$")).toEqual({});
  for (const source of [
    "a=1\na=2",
    "[a]\n[a]",
    "a=1\na.b=2",
    "constructor=1",
    "a=null",
    'a="unterminated',
    "a='unterminated",
    "a=1e999",
    "a={",
    "[1] extra",
    "a=true!",
  ])
    expect(() => tomlContainer(source, "$")).toThrow();
  expect(() => tomlContainer("[".repeat(25) + "0" + "]".repeat(25), "$")).toThrow();
  expect(() => tomlContainer("[" + Array(8192).fill("0").join(",") + "]", "$")).toThrow();
  expect(() => dataContainer("{", "json", "$")).toThrow("invalid-template");
  expect(dataContainer("{}", "json", "$")).toEqual({});
  const commands = new Set(["fixed"]),
    argvs = new Set(["argv"]);
  expect(() => {
    validateCommandSlots(
      {
        hooks: [{ type: "command", command: "fixed" }],
        notify: ["argv"],
        argv: ["argv"],
        type: "http",
      },
      commands,
      argvs,
      "$",
    );
  }).not.toThrow();
  for (const value of [
    { script: "run" },
    { type: "prompt" },
    { command: "literal" },
    { command: [] },
    { notify: "argv" },
    { notify: ["bad"] },
    { notify: ["argv", "extra"] },
    { module: {} },
  ])
    expect(() => {
      validateCommandSlots(value, commands, argvs, "$");
    }).toThrow("executable-template");
});
it("proves attachment conditions conservatively", () => {
  const t = { field: "control", op: "eq", value: true } as const;
  const other = { field: "resume", op: "eq", value: true } as const;
  expect(implies(undefined, undefined)).toBe(true);
  expect(implies(undefined, { all: [t], any: undefined })).toBe(false);
  expect(implies({ all: [t], any: undefined }, { all: [], any: [t, other] })).toBe(true);
  expect(implies({ all: [], any: [t] }, { all: [], any: [t, other] })).toBe(true);
  expect(implies({ all: [], any: [other] }, { all: [], any: [t] })).toBe(false);
  expect(implies({ all: [t], any: undefined }, { all: [t], any: undefined })).toBe(true);
});

it("rejects TOML values that cannot remain bounded plain data", () => {
  for (const source of [
    "a=1979-05-27",
    "a=nan",
    "a=inf",
    "a={prototype=1}",
    'a="\\u202e"',
    '["hidden\\u202e"]\na=1',
    '"fixed"\nscript="evil"',
  ])
    expect(() => tomlContainer(source, "$")).toThrow();
  expect(tomlContainer("a=0x3", "$")).toEqual({ a: 3 });
  expect(() => dataContainer('{"matcher":"\\u202e"}', "json", "$")).toThrow();
  const commands = new Set(["FOOM_OBSERVER_0_SENTINEL"]),
    argvs = new Set(["FOOM_OBSERVER_1_SENTINEL"]);
  for (const value of [
    { command: "FOOM_OBSERVER_0_SENTINEL extra" },
    { FOOM_OBSERVER_0_SENTINEL: true },
    { type: "command" },
    { commands: ["evil"] },
  ])
    expect(() => {
      validateCommandSlots(value, commands, argvs, "$");
    }).toThrow();
});
