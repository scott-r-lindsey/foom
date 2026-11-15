import { describe, expect, it } from "vitest";
import {
  parseSetupList,
  setupAction,
  setupSourcePath,
  setupPackageName,
} from "../../../src/shared/repository-setup";
import {
  setupArtifact,
  setupCatalog,
  setupPlan,
  setupVersionMatches,
  setupSelectedTools,
} from "../../../src/shared/repository-setup-catalog";
import type { RepositorySetupList, SetupCheck } from "../../../src/shared/repository-setup.d";
const draft = {
  evidence: ["README.md"],
  requirements: [
    {
      kind: "package",
      id: "native",
      purpose: "Build native modules",
      sources: ["package.json"],
      packages: { debian: ["make", "gcc"], rhel: ["gcc"], arch: ["base-devel"], darwin: [] },
    },
    {
      kind: "toolchain",
      id: "node",
      tool: "node",
      version: "24.x",
      purpose: "Run build tooling",
      sources: ["package.json"],
    },
  ],
};
const parse = (value: unknown) => parseSetupList(JSON.stringify(value));
const platform: SetupCheck["platform"] = {
  distro: "debian",
  os: "linux",
  arch: "x64",
  nodeAbi: true,
};
describe("profile-only repository setup suggestions", () => {
  it("canonicalizes a structured suggestion and preserves explicit empty and unsupported mappings", () => {
    const list = parse(draft);
    expect(list.requirements[0]).toMatchObject({
      packages: { debian: ["gcc", "make"], darwin: [] },
    });
    expect(parse({ requirements: [], evidence: [] })).toEqual({ requirements: [], evidence: [] });
    expect(
      parse({
        ...draft,
        requirements: [
          {
            ...draft.requirements[0],
            packages: { ...draft.requirements[0]?.packages, darwin: "unsupported" },
          },
        ],
      }).requirements[0],
    ).toMatchObject({ packages: { darwin: "unsupported" } });
  });
  it.each([
    null,
    [],
    { ...draft, command: "sudo make" },
    { ...draft, approval: true },
    { ...draft, requirements: [{ ...draft.requirements[0], command: "sh" }] },
    { ...draft, requirements: [{ ...draft.requirements[0], packages: { debian: ["gcc"] } }] },
    ...["-y", "x y", "x;id", "$(id)", "../../x", "https://a/b", "x\0"].map((name) => ({
      ...draft,
      requirements: [
        { ...draft.requirements[0], packages: { debian: [name], rhel: [], arch: [], darwin: [] } },
      ],
    })),
    { ...draft, requirements: [draft.requirements[0], draft.requirements[0]] },
    {
      ...draft,
      requirements: [draft.requirements[1], { ...draft.requirements[1], id: "another-node" }],
    },
    { ...draft, requirements: [{ ...draft.requirements[1], version: "latest" }] },
    { ...draft, requirements: [{ ...draft.requirements[1], version: "^24" }] },
    { ...draft, requirements: [{ ...draft.requirements[1], tool: "python" }] },
    { ...draft, requirements: [{ ...draft.requirements[0], purpose: "" }] },
    { ...draft, requirements: [{ ...draft.requirements[0], purpose: "x".repeat(501) }] },
    { ...draft, requirements: [{ ...draft.requirements[0], sources: ["../secret"] }] },
    { ...draft, evidence: ["README.md", "README.md"] },
    { ...draft, evidence: Array.from({ length: 65 }, (_, i) => `file-${String(i)}`) },
    {
      ...draft,
      requirements: Array.from({ length: 129 }, (_, i) => ({
        ...draft.requirements[1],
        id: `item-${String(i)}`,
      })),
    },
    {
      ...draft,
      requirements: [
        {
          ...draft.requirements[0],
          packages: { debian: ["gcc", "gcc"], rhel: [], arch: [], darwin: [] },
        },
      ],
    },
  ])("refuses malformed/unresolved executable or unbounded suggestion data %#", (value) => {
    expect(() => parse(value)).toThrow();
  });
  it("rejects invalid and oversized JSON without returning an executable", () => {
    for (const text of ["{", "\0", " ".repeat(65537), '"\\ud800"'])
      expect(() => parseSetupList(text)).toThrow();
  });
  it.each([
    "/root",
    "../x",
    "a/../x",
    "a\\b",
    "C:x",
    "a//b",
    ".git/config",
    "a/./b",
    "x\n",
    "x".repeat(161),
    "",
  ])("refuses unsafe evidence path %j", (path) => {
    expect(setupSourcePath(path)).toBe(false);
  });
  it("validates closed human IPC actions", () => {
    for (const value of [
      { action: "list" },
      { action: "review", repository: "/repo" },
      { action: "review", repository: "/repo", draft: "{}" },
      { action: "approve", token: "a".repeat(32) },
      { action: "run", token: "b".repeat(32) },
      { action: "remove", repository: "/repo" },
      { action: "check", repository: "/repo", host: null },
      { action: "check", repository: "/repo", host: "builder@host" },
    ])
      expect(setupAction(value)).toBe(true);
    for (const value of [
      null,
      {},
      { action: "list", approval: true },
      { action: "run", token: "bad" },
      { action: "check", repository: "/repo", host: "$(id)" },
      { action: "review", repository: "" },
      { action: "review", repository: "/repo", draft: 1 },
      { action: "unknown" },
    ])
      expect(setupAction(value)).toBe(false);
  });
});
describe("fixed repository setup catalog", () => {
  const list = parse(draft);
  const check: SetupCheck = {
    platform,
    items: [
      { id: "native", state: "missing" },
      { id: "node", state: "missing" },
    ],
  };
  it("selects fixed argv, refreshes apt and skips met requirements", () => {
    expect(setupPlan(list, check)?.steps).toEqual([
      ["/usr/bin/sudo", "/usr/bin/apt-get", "update"],
      ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", "--no-remove", "--", "gcc", "make"],
      ["foom-host", "--repository-toolchain", "node", setupCatalog.node.version],
    ]);
    expect(
      setupPlan(list, { ...check, items: check.items.map((item) => ({ ...item, state: "met" })) })
        ?.steps,
    ).toEqual([]);
  });
  it.each(["rhel", "arch"] as const)(
    "refuses automatic %s transactions without a no-removal guarantee",
    (distro) => {
      expect(setupPlan(list, { ...check, platform: { ...platform, distro } })).toBeUndefined();
      expect(
        setupPlan(list, {
          ...check,
          platform: { ...platform, distro },
          items: check.items.map((item) => ({ ...item, state: "met" })),
        })?.steps,
      ).toEqual([]);
    },
  );
  it("uses only formula operands for Homebrew", () => {
    const mac = parse({
      ...draft,
      requirements: [
        {
          ...draft.requirements[0],
          packages: { debian: [], rhel: [], arch: [], darwin: ["pkg-config", "python@3.13"] },
        },
      ],
    });
    expect(
      setupPlan(mac, {
        platform: { ...platform, distro: "darwin" },
        items: [{ id: "native", state: "missing" }],
      })?.steps,
    ).toEqual([["brew", "install", "--formula", "--", "pkg-config", "python@3.13"]]);
  });
  it("never guesses a recipe for unknown probes, unsupported platforms, ABI or uncatalogued versions", () => {
    for (const state of ["unable", "manual"] as const)
      expect(
        setupPlan(list, { ...check, items: check.items.map((item) => ({ ...item, state })) }),
      ).toBeUndefined();
    expect(setupPlan(list, { ...check, items: [] })).toBeUndefined();
    expect(
      setupPlan(list, {
        ...check,
        items: [
          { id: "unrecognized", state: "missing" },
          { id: "node", state: "met" },
        ],
      }),
    ).toBeUndefined();
    expect(
      setupPlan(list, { ...check, platform: { ...platform, distro: "unsupported" } }),
    ).toBeUndefined();
    expect(
      setupPlan(list, { ...check, platform: { ...platform, nodeAbi: false } }),
    ).toBeUndefined();
    expect(
      setupPlan(
        parse({ ...draft, requirements: [{ ...draft.requirements[1], version: "26.x" }] }),
        { ...check, items: [{ id: "node", state: "missing" }] },
      ),
    ).toBeUndefined();
    const unsupported: RepositorySetupList = parse({
      requirements: [
        {
          ...draft.requirements[0],
          packages: { debian: "unsupported", rhel: [], arch: [], darwin: [] },
        },
      ],
      evidence: [],
    });
    expect(
      setupPlan(unsupported, { ...check, items: [{ id: "native", state: "missing" }] }),
    ).toBeUndefined();
  });
  it("never shadows a required system version with a different private catalog version", () => {
    expect(setupSelectedTools(list)).toEqual(["node"]);
    expect(
      setupSelectedTools(
        parse({ requirements: [{ ...draft.requirements[1], version: "26.x" }], evidence: [] }),
      ),
    ).toEqual([]);
  });
  it("has exact official artifacts, with no latest fallback", () => {
    expect(setupArtifact("node", platform)?.url).toMatch(/node-v24\.17\.0-linux-x64\.tar\.gz$/u);
    expect(setupArtifact("node", { ...platform, arch: "unsupported" })).toBeUndefined();
    expect(setupArtifact("pnpm", platform)).toMatchObject({
      algorithm: "sha512",
      encoding: "base64",
    });
    expect(setupVersionMatches("24.17.0", "24.x")).toBe(true);
    expect(setupVersionMatches("24.17.0", "24.17.0")).toBe(true);
    expect(setupVersionMatches("26.0.0", "24.x")).toBe(false);
  });
});

it.each(["debian", "rhel", "arch", "darwin"] as const)(
  "rejects every modifier operand at the %s parser and recipe sink",
  (distro) => {
    for (const name of [
      "bash-",
      "bash+",
      "-bash",
      "bash=1",
      "bash/edge",
      "bash*",
      "bash?",
      "bash[0]",
      "bash{a,b}",
      "bash\\x",
      "bash:amd64",
      "Bash",
      ".bash",
      "@bash",
    ]) {
      expect(setupPackageName(name, distro)).toBe(false);
      const raw = {
        ...draft,
        requirements: [
          {
            ...draft.requirements[0],
            packages: { debian: [], rhel: [], arch: [], darwin: [], [distro]: [name] },
          },
        ],
      };
      expect(() => parse(raw)).toThrow();
      const forged: RepositorySetupList = {
        requirements: [
          {
            kind: "package",
            id: "native",
            purpose: "Build",
            sources: [],
            packages: { debian: [], rhel: [], arch: [], darwin: [], [distro]: [name] },
          },
        ],
        evidence: [],
      };
      expect(
        setupPlan(forged, {
          platform: { ...platform, distro },
          items: [{ id: "native", state: "missing" }],
        }),
      ).toBeUndefined();
    }
  },
);
it("uses manager-specific literal package grammars", () => {
  for (const name of ["gcc", "g++-12", "libstdc++6", "libfoo-dev"])
    expect(setupPackageName(name, "debian")).toBe(true);
  expect(setupPackageName("foo_bar", "debian")).toBe(false);
  expect(setupPackageName("foo.bar", "debian")).toBe(false);
  expect(setupPackageName("python@@3.13", "darwin")).toBe(false);
  expect(setupPackageName("foo_bar", "rhel")).toBe(true);
  expect(setupPackageName("foo_bar", "arch")).toBe(true);
  expect(setupPackageName("python@3.13", "darwin")).toBe(true);
  expect(setupPackageName("python@3.13", "debian")).toBe(false);
});
