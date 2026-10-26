import { afterEach, expect, it, vi } from "vitest";
import { cp, mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSetup } from "../../../../src/main/agents/plugin-setup";
import { stagePlugin } from "../../../../src/main/agents/plugin-staging";
import { readSetupMetadata, select } from "../../../../src/main/agents/setup-metadata";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import fixture from "../../../fixtures/agent-plugins-v2/agy.json";
import type { AgentManifestV2 } from "../../../../src/shared/agent-manifest-v2";
import type { DialogContent } from "../../../../src/shared/confirmation";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error("Missing fixture");
  return value;
}
function model(): AgentManifestV2 {
  const parsed = parseAgentManifest(JSON.stringify({ ...fixture, id: "setup-fixture" }));
  const m = parsed.model;
  m.hooks = undefined;
  m.files = [
    {
      name: "plugin.json",
      scope: "plugin",
      format: "json",
      content: JSON.stringify({ name: "foom", version: "1.0.0", foomObserverVersion: 2 }),
      when: undefined,
    },
  ];
  return m;
}
async function environment() {
  const home = await mkdtemp(join(tmpdir(), "foom-plugin-test-"));
  roots.push(home);
  const executable = join(home, "fixture-cli");
  await writeFile(executable, "fixture executable");
  const directory = join(home, ".gemini/config/plugins/foom");
  const manifest = join(directory, "plugin.json");
  const config = join(home, ".gemini/config/config.json");
  const owned = async (version = 2, enabled?: boolean) => {
    await mkdir(directory, { recursive: true });
    await writeFile(manifest, JSON.stringify({ name: "foom", foomObserverVersion: version }));
    if (enabled !== undefined)
      await writeFile(config, JSON.stringify({ plugins: { foom: { enabled } } }));
  };
  const run = vi.fn(async (_exe: string, args: readonly string[]) => {
    if (args[1] === "list") return { stdout: JSON.stringify({ imports: [] }) };
    if (args[1] === "install") {
      await mkdir(directory, { recursive: true });
      await cp(required(args[2]), directory, { recursive: true });
    }
    if (args[1] === "enable")
      await writeFile(config, JSON.stringify({ plugins: { foom: { enabled: true } } }));
    if (args[1] === "uninstall") await rm(directory, { recursive: true });
    return { stdout: "" };
  });
  const m = model();
  const service = new PluginSetup(home, run);
  const input = (
    action = "install",
    confirm: (content: DialogContent) => Promise<boolean> = () => Promise.resolve(true),
  ) => ({
    model: m,
    executable,
    action,
    validate: vi.fn(async () => {}),
    facts: () => ({}),
    confirm,
    stage: () => stagePlugin(m, home, {}, process.platform === "win32", home),
    signal: new AbortController().signal,
  });
  return {
    home,
    executable,
    directory,
    manifest,
    config,
    owned,
    run,
    m,
    service,
    input,
    status: () => service.status(m, executable),
  };
}
it("installs, updates, enables and removes with fixed argv and bounded commands", async () => {
  const e = await environment();
  expect(await e.status()).toMatchObject({ state: "not-installed", actions: [{ id: "install" }] });
  const confirm = vi.fn((_content: DialogContent) => Promise.resolve(true));
  await e.service.change(e.input("install", confirm));
  expect(await e.status()).toMatchObject({ state: "installed" });
  expect(JSON.stringify(confirm.mock.calls)).toContain("Staged files");
  expect(JSON.stringify(confirm.mock.calls)).toContain(e.executable);
  const call = e.run.mock.calls.find((entry) => entry[1][1] === "install");
  expect(call?.[1]).toEqual(["plugin", "install", expect.stringContaining("agent-plugins")]);
  await e.owned(1);
  expect(await e.status()).toMatchObject({ state: "outdated" });
  await e.service.change(e.input("update"));
  expect(await e.status()).toMatchObject({ state: "installed" });
  await e.owned(2, false);
  expect(await e.status()).toMatchObject({ state: "disabled" });
  await e.service.change(e.input("enable"));
  expect(await e.status()).toMatchObject({ state: "installed" });
  await e.service.change(e.input("remove"));
  expect(await e.status()).toMatchObject({ state: "not-installed" });
  expect(e.run).toHaveBeenCalledWith(
    e.executable,
    ["plugin", "enable", "foom"],
    expect.objectContaining({
      timeout: 5000,
      maxBuffer: 65536,
      encoding: "utf8",
      killSignal: "SIGKILL",
    }),
  );
});
it("cancels without mutation and serializes conflicting copies across service instances", async () => {
  const e = await environment();
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = e.service.change(
    e.input("install", async () => {
      entered?.();
      await waiting;
      return false;
    }),
  );
  await seen;
  await expect(new PluginSetup(e.home, e.run).change(e.input())).rejects.toThrow("busy");
  release?.();
  await pending;
  expect(e.run.mock.calls.every((entry) => entry[1][1] === "list")).toBe(true);
  await e.service.change(e.input()); // cancellation releases the lock
});
it("rejects changed validation, executable, ownership and state after confirmation", async () => {
  for (const change of ["validation", "executable", "ownership", "state", "stage"]) {
    const e = await environment();
    let valid = true;
    const input = e.input("install", async () => {
      if (change === "validation") valid = false;
      if (change === "executable") await writeFile(e.executable, "replaced executable");
      if (change === "ownership") {
        await e.owned();
        await writeFile(e.manifest, '{"name":"other"}');
      }
      if (change === "state") await e.owned();
      if (change === "stage") {
        const staging = await input.stage();
        await writeFile(join(staging.directory, "plugin.json"), "{}");
      }
      return true;
    });
    input.validate = vi.fn(() => {
      if (!valid) throw Error("Agent plugin changed");
      return Promise.resolve();
    });
    await expect(e.service.change(input)).rejects.toThrow();
    expect(e.run.mock.calls.every((entry) => entry[1][1] === "list")).toBe(true);
  }
});
it("distinguishes missing, malformed, oversized, invalid UTF-8 and unrecognized metadata", async () => {
  const e = await environment();
  expect(await e.status()).toMatchObject({ state: "not-installed" });
  await mkdir(e.directory, { recursive: true });
  expect(await e.status()).toEqual({ state: "unavailable", actions: [] });
  for (const content of [
    "{",
    "[]",
    '{"name":"other","foomObserverVersion":2}',
    '{"name":"foom","foomObserverVersion":-1}',
    '{"name":"foom","foomObserverVersion":"2"}',
    " ".repeat(65537),
    Buffer.from([0xff]),
  ]) {
    await writeFile(e.manifest, content);
    expect(await e.status()).toEqual({ state: "unavailable", actions: [] });
    await expect(e.service.change(e.input("remove"))).rejects.toThrow();
  }
  await e.owned();
  for (const config of [
    "[]",
    '{"plugins":false}',
    '{"plugins":{"foom":0}}',
    '{"plugins":{"foom":{"enabled":0}}}',
  ]) {
    await writeFile(e.config, config);
    expect(await e.status()).toEqual({ state: "unavailable", actions: [] });
  }
  await writeFile(e.config, "{}");
  expect(await e.status()).toMatchObject({ state: "installed" });
  required(e.m.setup).status.metadata.push({
    id: "required",
    path: ".gemini/config/config.json",
    optional: false,
  });
  await rm(e.config);
  expect(await e.status()).toMatchObject({ state: "unavailable" });
});
it("refuses symlinked files and ancestors, hard links and nonregular entries", async () => {
  const e = await environment();
  await e.owned();
  const saved = join(e.home, "saved.json");
  await writeFile(saved, '{"name":"foom","foomObserverVersion":2}');
  await rm(e.manifest);
  await symlink(saved, e.manifest);
  expect(await e.status()).toMatchObject({ state: "unavailable" });
  await rm(e.manifest);
  await link(saved, e.manifest);
  expect(await e.status()).toMatchObject({ state: "unavailable" });
  await rm(e.manifest);
  await mkdir(e.manifest);
  expect(await e.status()).toMatchObject({ state: "unavailable" });
  await rm(e.directory, { recursive: true });
  await symlink(e.home, e.directory, process.platform === "win32" ? "junction" : "dir");
  expect(await e.status()).toMatchObject({ state: "unavailable" });
  await rm(e.directory);
  await rm(join(e.home, ".gemini"), { recursive: true });
  await symlink(e.home, join(e.home, ".gemini"), process.platform === "win32" ? "junction" : "dir");
  expect(await e.status()).toMatchObject({ state: "unavailable" });
});
it("validates probe shape, name bounds, output limits and conflict with a missing manifest", async () => {
  const e = await environment();
  for (const stdout of [
    "{}",
    '{"imports":{}}',
    '{"imports":[{}]}',
    JSON.stringify({ imports: [{ name: "a".repeat(65) }] }),
    JSON.stringify({ imports: Array.from({ length: 65 }, () => ({ name: "x" })) }),
    " ".repeat(65537),
    '{"imports":[{"name":"foom"}]}',
  ]) {
    e.run.mockResolvedValueOnce({ stdout });
    expect(await e.status()).toEqual({ state: "unavailable", actions: [] });
  }
  e.run.mockResolvedValueOnce({ stdout: "No imported plugins.\n" });
  expect(await e.status()).toMatchObject({ state: "not-installed" });
  e.run.mockRejectedValueOnce(Error("raw secret failure"));
  expect(await e.status()).toMatchObject({ state: "unavailable" });
  expect(await e.service.status({ ...e.m, setup: undefined }, e.executable)).toEqual({
    state: "unavailable",
    actions: [],
  });
});
it("aborts before mutation, bounds command failures, and requires rescan after a failing post-probe", async () => {
  const e = await environment();
  const abort = new AbortController();
  abort.abort();
  await expect(e.service.change({ ...e.input(), signal: abort.signal })).rejects.toThrow();
  await expect(e.service.change(e.input("unknown"))).rejects.toThrow("Unknown");
  await expect(e.service.change(e.input("remove"))).rejects.toThrow("changed");
  const run = e.run.getMockImplementation();
  e.run.mockImplementation(async (exe, args) => {
    if (args[1] === "install") throw Error("secret subprocess error");
    return required(run)(exe, args);
  });
  await expect(e.service.change(e.input())).rejects.toThrow(
    "Plugin setup command failed. Scan again",
  );
  e.run.mockImplementation(async (exe, args) => {
    const result = await required(run)(exe, args);
    if (args[1] === "install") e.run.mockRejectedValueOnce(Error("bad post probe"));
    return result;
  });
  await expect(e.service.change(e.input())).rejects.toThrow("Plugin setup command failed");
  await e.owned(2, false);
  const input = e.input("enable", () => {
    abort.abort();
    return Promise.resolve(true);
  });
  await expect(e.service.change({ ...input, signal: abort.signal })).rejects.toThrow();
});
it("keeps instruction actions inert, with a separate trusted disclosure and no CLI mutation", async () => {
  const e = await environment();
  const setup = required(e.m.setup);
  setup.actions = [
    {
      id: "review",
      label: "Review",
      kind: "instructions",
      arguments: undefined,
      instructions: "Open /hooks yourself.",
      when: { all: [], any: undefined },
      disclosure: "Review these definitions",
      statusProbe: "observed-health",
    },
  ];
  setup.status = {
    probe: undefined,
    metadata: [],
    ownership: undefined,
    cases: [],
    default: "unavailable",
  };
  const confirm = vi.fn((_content: DialogContent) => Promise.resolve(true));
  await e.service.change(e.input("review", confirm));
  expect(JSON.stringify(confirm.mock.calls)).toContain("Open /hooks yourself.");
  const sections = confirm.mock.calls[0]?.[0].sections;
  expect(
    sections?.find((section) => section.label === "Executable and fixed arguments")?.summary,
  ).toEqual([
    {
      text: "fixture-cli",
      title: /[\s"\\]/u.test(e.executable) ? JSON.stringify(e.executable) : e.executable,
    },
  ]);
  expect(sections?.find((section) => section.label === "Installation and state")?.summary).toEqual([
    {
      text: "setup-fixture · No installation change · unavailable",
      title: "setup-fixture · No installation change · unavailable",
    },
  ]);
  expect(e.run).not.toHaveBeenCalled();
});
it("evaluates metadata/probe selectors without inherited properties", async () => {
  const e = await environment();
  await e.owned();
  const setup = required(e.m.setup);
  setup.status.cases = [
    {
      state: "installed",
      when: {
        all: [
          { field: { source: "metadata", path: ["manifest", "name"] }, op: "eq", value: "foom" },
        ],
        any: undefined,
      },
    },
  ];
  expect(await e.status()).toMatchObject({ state: "installed" });
  expect(select({ source: "metadata", path: ["toString"] }, { metadata: {} })).toBeUndefined();
  expect(
    select(
      { source: "probe", path: ["imports", 0, "name"] },
      { probe: { imports: [{ name: "foom" }] } },
    ),
  ).toBe("foom");
  expect(await readSetupMetadata(e.home, ".gemini/config/config.json")).toBeUndefined();
});
it("stages immutable private files, reuses identical content and refuses tampering or missing files", async () => {
  const e = await environment();
  e.m.files.push({
    name: "config/hooks.json",
    scope: "plugin",
    format: "json",
    content: "{}",
    when: undefined,
  });
  const stage = await stagePlugin(e.m, e.home, {}, process.platform === "win32", e.home);
  expect((await stagePlugin(e.m, e.home, {}, process.platform === "win32", e.home)).directory).toBe(
    stage.directory,
  );
  await stage.verify();
  await writeFile(join(stage.directory, "config/hooks.json"), "[]");
  await expect(stage.verify()).rejects.toThrow("changed");
  e.m.files = [];
  await expect(stagePlugin(e.m, e.home, {}, process.platform === "win32", e.home)).rejects.toThrow(
    "Missing",
  );
  e.m.files = [
    {
      name: "plugin.json",
      scope: "plugin",
      format: "json",
      content: '{"version":{observerVersion:lifecycle}}',
      when: undefined,
    },
  ];
  await expect(stagePlugin(e.m, e.home, {}, process.platform === "win32", e.home)).rejects.toThrow(
    "Unselected",
  );
});

it("does not let authored status cases relabel current or enabled installations into mutation authority", async () => {
  for (const [state, action] of [
    ["outdated", "update"],
    ["disabled", "enable"],
  ] as const) {
    const e = await environment();
    await e.owned();
    required(e.m.setup).status.cases = [{ state, when: { all: [], any: undefined } }];
    await expect(e.service.change(e.input(action))).rejects.toThrow("changed");
    expect(e.run.mock.calls.every((entry) => entry[1][1] === "list")).toBe(true);
  }
});
it("cancels an in-flight CLI operation through the process abort signal and releases its lock", async () => {
  const e = await environment();
  const abort = new AbortController();
  const service = new PluginSetup(e.home, (_exe, args, options) => {
    if (args[1] === "list") return Promise.resolve({ stdout: '{"imports":[]}' });
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          reject(Error("Aborted fixture command"));
        },
        { once: true },
      );
      abort.abort();
    });
  });
  await expect(service.change({ ...e.input(), signal: abort.signal })).rejects.toThrow(
    "Plugin setup command failed",
  );
  await e.service.change(e.input());
});

it("never exposes raw status-probe stderr when an action cannot recheck ownership", async () => {
  const e = await environment();
  e.run.mockRejectedValueOnce(Error("private CLI stderr must not leave main"));
  await expect(e.service.change(e.input())).rejects.toThrow(
    "Plugin setup status unavailable. Scan again.",
  );
});

it("rejects mutation probes and ownership without the fixed list probe at the parser boundary", () => {
  for (const probe of [undefined, { arguments: ["plugin", "uninstall", "foom"], format: "json" }]) {
    expect(() =>
      parseAgentManifest(
        JSON.stringify({
          ...fixture,
          id: "setup-fixture",
          setup: { ...fixture.setup, status: { ...fixture.setup.status, probe } },
        }),
      ),
    ).toThrow("incompatible-combination");
  }
});
it("refuses unreviewed extra staging files before any CLI receives the staging directory", async () => {
  const e = await environment();
  const stage = await stagePlugin(e.m, e.home, {}, process.platform === "win32", e.home);
  await writeFile(join(stage.directory, "unreviewed.json"), "{}");
  await expect(stage.verify()).rejects.toThrow("Staged plugin changed");
});

it("requires the post-probe to verify mutations even when the CLI exits successfully", async () => {
  for (const action of ["install", "enable", "remove"] as const) {
    const e = await environment();
    if (action !== "install") await e.owned(2, action === "enable" ? false : true);
    e.run.mockImplementation(() => Promise.resolve({ stdout: '{"imports":[]}' }));
    await expect(e.service.change(e.input(action))).rejects.toThrow(
      "Plugin setup command failed. Scan again",
    );
  }
});

it("preserves a CLI-owned disabled preference after install and offers enable separately", async () => {
  const e = await environment();
  await mkdir(join(e.home, ".gemini/config"), { recursive: true });
  await writeFile(e.config, JSON.stringify({ plugins: { foom: { enabled: false } } }));
  await e.service.change(e.input());
  expect(await e.status()).toMatchObject({
    state: "disabled",
    actions: [{ id: "enable" }, { id: "remove" }],
  });
});

it("serializes case aliases of an installation on case-insensitive platforms", async () => {
  const e = await environment();
  const copy = structuredClone(e.m);
  const ownership = required(required(copy.setup).status.ownership);
  ownership.directory = ownership.directory.replace(".gemini", ".Gemini");
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new PluginSetup(e.home, e.run, true).change(
    e.input("install", async () => {
      entered?.();
      await waiting;
      return false;
    }),
  );
  await seen;
  try {
    await expect(
      new PluginSetup(e.home, e.run, true).change({ ...e.input(), model: copy }),
    ).rejects.toThrow("busy");
  } finally {
    release?.();
    await pending;
  }
});

it("refuses trailing-dot and Windows device aliases in plugin metadata paths on every platform", () => {
  for (const name of ["foom.", "CON", "nul.json", "LPT1"]) {
    const data = structuredClone(fixture);
    const entry = required(data.setup.status.metadata[0]);
    entry.path = `.gemini/config/plugins/${name}/plugin.json`;
    expect(() => parseAgentManifest(JSON.stringify({ ...data, id: "setup-fixture" }))).toThrow(
      "unsafe-file",
    );
  }
});

it("offers an update when generated observer definitions change at the same ABI and verifies the installed fingerprint", async () => {
  const e = await environment();
  const observerModel = parseAgentManifest(
    JSON.stringify({ ...fixture, id: "setup-fixture" }),
  ).model;
  Object.assign(e.m, observerModel);
  await e.service.change(e.input());
  expect(await e.status()).toMatchObject({ state: "installed" });
  const channel = e.m.hooks?.channels[0];
  if (!channel) throw Error("Missing fixture channel");
  channel.observer.timeoutMs = 2000;
  const outdated = await e.status();
  expect(outdated.state).toBe("outdated");
  expect(outdated.actions).toContainEqual({ id: "update", label: "Update" });
  await e.service.change(e.input("update"));
  expect(await e.status()).toMatchObject({ state: "installed" });
  await writeFile(e.manifest, JSON.stringify({ name: "foom", foomObserverVersion: 2 }));
  expect(await e.status()).toMatchObject({ state: "outdated" });
  e.run.mockImplementation(async (_exe, args) => {
    if (args[1] === "install")
      await writeFile(e.manifest, JSON.stringify({ name: "foom", foomObserverVersion: 2 }));
    return { stdout: '{"imports":[]}' };
  });
  await expect(e.service.change(e.input("update"))).rejects.toThrow("command failed");
});

it.each(["extra", "link", "changed"])(
  "refuses %s observer assets changed during trusted setup confirmation before running the CLI",
  async (failure) => {
    const e = await environment();
    Object.assign(
      e.m,
      parseAgentManifest(JSON.stringify({ ...fixture, id: "setup-fixture" })).model,
    );
    const staged = await stagePlugin(e.m, e.home, {}, process.platform === "win32", e.home);
    const target = join(
      staged.directory,
      "observers/lifecycle",
      process.platform === "win32" ? "observer.ps1" : "observer.sh",
    );
    const input = e.input("install", async () => {
      if (failure === "extra") await writeFile(join(staged.directory, "unexpected.json"), "{}");
      if (failure === "changed") await writeFile(target, "changed");
      if (failure === "link") {
        const outside = join(e.home, "outside");
        await writeFile(outside, "outside");
        await rm(target);
        await symlink(outside, target);
      }
      return true;
    });
    await expect(e.service.change(input)).rejects.toThrow();
    expect(e.run.mock.calls.every((entry) => entry[1][1] === "list")).toBe(true);
  },
);

it.each([0, 1, 2, 3, 100001])(
  "requires an anchored update for legacy bundled observer version %s",
  async (version) => {
    const e = await environment();
    const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
    Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
    await e.owned(version);
    expect(await e.status()).toMatchObject({ state: "outdated" });
    expect(e.run.mock.calls.every((entry) => entry[1][1] === "list")).toBe(true);
    expect(await readFile(e.manifest, "utf8")).toBe(
      JSON.stringify({ name: "foom", foomObserverVersion: version }),
    );
  },
);

it("preserves native observer bytes while anchoring hook commands on both platforms", async () => {
  const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
  const { pluginContent } = await import("../../../../src/main/agents/plugin-staging");
  const { agyPluginFiles } = await import("../../../../src/main/agents/agy-observer");
  const m = parseAgentManifest(JSON.stringify(bundled), "bundled").model;
  for (const windows of [false, true]) {
    const staged = pluginContent(m, {}, windows);
    const old = agyPluginFiles(windows ? "win32" : "linux");
    const files = Object.fromEntries(staged.content.map(({ name, content }) => [name, content]));
    for (const [name, content] of Object.entries(old)) {
      if (name === "plugin.json") {
        expect(JSON.parse(files[name] ?? "")).toEqual({
          name: "foom",
          version: "1.0.0",
          foomObserverVersion: 4,
          foomStagingFingerprint: staged.fingerprint,
        });
      } else if (name === "hooks.json") expect(files[name]).not.toContain("./observer.");
      else if (name !== "mcp_config.json" && (windows || name === "observer.sh"))
        expect(files[name]).toBe(content);
    }
  }
});

it("requires reviewed update for an explicit mismatched fingerprint and refuses unknown ownership", async () => {
  const e = await environment();
  const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
  Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
  await e.owned();
  await writeFile(
    e.manifest,
    JSON.stringify({ name: "foom", foomObserverVersion: 2, foomStagingFingerprint: "changed" }),
  );
  expect(await e.status()).toMatchObject({ state: "outdated" });
  await e.service.change(e.input("update", () => Promise.resolve(false)));
  expect(e.run.mock.calls.every((entry) => entry[1][1] === "list")).toBe(true);
  await e.service.change(e.input("update"));
  expect(await e.status()).toMatchObject({ state: "installed" });
  await writeFile(e.manifest, JSON.stringify({ name: "someone-else", foomObserverVersion: 2 }));
  expect(await e.status()).toEqual({ state: "unavailable", actions: [] });
  await expect(e.service.change(e.input("remove"))).rejects.toThrow("ownership");
});

it("keeps an installed plugin with a missing enabled preference leaf unavailable", async () => {
  const e = await environment();
  const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
  Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
  await e.owned(2);
  await writeFile(e.config, JSON.stringify({ plugins: { foom: {} } }));
  expect(await e.status()).toEqual({ state: "unavailable", actions: [] });
  await expect(e.service.change(e.input("remove"))).rejects.toThrow("changed");
  expect(e.run.mock.calls.every((entry) => entry[1][1] === "list")).toBe(true);
});

it.each([
  "missing-target",
  "changed-target",
  "changed-hooks",
  "linked-target",
  "path-dot",
  "path-parent",
  "path-double",
  "path-trailing",
  "path-symlink-parent",
  "path-missing",
  "path-relative",
  "path-outside",
  "path-control",
  "path-long",
  "path-type",
])("offers repair for a matching fingerprint with %s", async (failure) => {
  const e = await environment();
  const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
  Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
  await e.service.change(e.input());
  const observer = join(e.directory, process.platform === "win32" ? "observer.ps1" : "observer.sh");
  let reported: unknown = e.directory;
  if (failure === "missing-target") await rm(observer);
  if (failure === "changed-target") await writeFile(observer, "changed");
  if (failure === "changed-hooks") await writeFile(join(e.directory, "hooks.json"), "{}");
  if (failure === "linked-target") {
    await rm(observer);
    await symlink(e.manifest, observer);
  }
  if (failure === "path-dot") reported = `${e.directory}/.`;
  if (failure === "path-parent") reported = `${e.directory}/../foom`;
  if (failure === "path-double") reported = `${e.directory}//`;
  if (failure === "path-trailing") reported = `${e.directory}/`;
  if (failure === "path-symlink-parent") {
    const foreign = join(e.home, "foreign");
    await mkdir(join(foreign, "child"), { recursive: true });
    await mkdir(join(foreign, ".gemini/config/plugins/foom"), { recursive: true });
    await symlink(
      join(foreign, "child"),
      join(e.home, "redirect"),
      process.platform === "win32" ? "junction" : "dir",
    );
    reported = `${e.home}/redirect/../.gemini/config/plugins/foom`;
  }
  if (failure === "path-missing") reported = undefined;
  if (failure === "path-relative") reported = ".gemini/config/plugins/foom";
  if (failure === "path-outside") reported = join(e.home, "outside");
  if (failure === "path-control") reported = `${e.directory}\n`;
  if (failure === "path-long") reported = "/".repeat(4097);
  if (failure === "path-type") reported = {};
  const runner = required(e.run.getMockImplementation());
  e.run.mockImplementation((executable, args) =>
    args[1] === "list"
      ? Promise.resolve({
          stdout: JSON.stringify([{ name: "foom", enabled: true, path: reported }]),
        })
      : runner(executable, args),
  );
  const status = await e.status();
  if (failure.startsWith("path-")) {
    expect(status).toEqual({ state: "unavailable", actions: [] });
  } else {
    expect(status.state).toBe("outdated");
    expect(status.actions).toContainEqual({ id: "update", label: "Update" });
    expect(status.actions).toContainEqual({ id: "reinstall", label: "Reinstall plugin" });
  }
});

it("keeps a disposable-profile install working across Dev/everyday scans after deleting its staging", async () => {
  const e = await environment();
  const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
  Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
  const disposable = join(e.home, "fresh-profile");
  const everyday = join(e.home, "everyday-profile");
  await mkdir(disposable);
  await mkdir(everyday);
  const input = e.input();
  input.stage = () => stagePlugin(e.m, disposable, {}, process.platform === "win32", e.home);
  await e.service.change(input);
  await rm(disposable, { recursive: true });
  const runner = required(e.run.getMockImplementation());
  e.run.mockImplementation(async (executable, args) => {
    if (args[1] !== "list") return runner(executable, args);
    const entries = await readFile(e.manifest).then(
      () => [{ name: "foom", enabled: true, path: e.directory }],
      () => [],
    );
    return { stdout: JSON.stringify(entries) };
  });
  const other = new PluginSetup(e.home, e.run);
  for (let scan = 0; scan < 3; scan++) {
    expect((await e.status()).state).toBe("installed");
    expect((await other.status(e.m, e.executable)).state).toBe("installed");
  }
  const hooks = await readFile(join(e.directory, "hooks.json"), "utf8");
  expect(hooks).not.toContain("fresh-profile");
  expect(hooks).not.toContain("everyday-profile");
  const repair = e.input("reinstall");
  repair.stage = () => stagePlugin(e.m, everyday, {}, process.platform === "win32", e.home);
  await e.service.change(repair);
  expect(await readFile(join(e.directory, "hooks.json"), "utf8")).toBe(hooks);
  expect((await e.status()).state).toBe("installed");
});

it.each([
  [[], undefined, "not-installed"],
  [[{ name: "foom", enabled: true, hooks: ["foom-observer-v1"] }], 1, "outdated"],
  [[{ name: "foom", enabled: false }], 3, "disabled"],
  [[{ name: "foom", enabled: "yes" }], 1, "unavailable"],
  [
    [
      { name: "foom", enabled: true },
      { name: "foom", enabled: false },
    ],
    1,
    "unavailable",
  ],
  [{ imports: [] }, undefined, "not-installed"],
  ["malformed", undefined, "unavailable"],
])("validates modern and legacy probe output %j", async (list, version, state) => {
  const e = await environment();
  const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
  Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
  if (version !== undefined) await e.owned(version);
  e.run.mockResolvedValue({
    stdout: JSON.stringify(
      Array.isArray(list) ? list.map((entry) => ({ ...entry, path: e.directory })) : list,
    ),
  });
  expect((await e.status()).state).toBe(state);
  expect(e.run).toHaveBeenCalledWith(
    e.executable,
    ["plugin", "list", "--json"],
    expect.any(Object),
  );
  expect(e.run).toHaveBeenCalledTimes(1);
});

it("falls back only on a failed JSON command, retaining legacy empty output", async () => {
  const e = await environment();
  const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
  Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
  e.run
    .mockRejectedValueOnce(Error("unknown --json"))
    .mockResolvedValueOnce({ stdout: "No imported plugins." });
  expect((await e.status()).state).toBe("not-installed");
  expect(e.run.mock.calls.map((call) => call[1])).toEqual([
    ["plugin", "list", "--json"],
    ["plugin", "list"],
  ]);
  e.run.mockClear();
  e.run.mockResolvedValue({ stdout: "Installed plugins:" });
  expect((await e.status()).state).toBe("unavailable");
  expect(e.run).toHaveBeenCalledTimes(1);
});

it("does not run the legacy fallback when a setup probe is cancelled", async () => {
  const e = await environment();
  const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
  Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
  const controller = new AbortController();
  e.run.mockImplementation(() => {
    controller.abort();
    return Promise.reject(Error("cancelled probe"));
  });
  await expect(e.service.change({ ...e.input(), signal: controller.signal })).rejects.toThrow();
  expect(e.run).toHaveBeenCalledTimes(1);
  expect(e.run.mock.calls[0]?.[1]).toEqual(["plugin", "list", "--json"]);
});

it.each(["installed", "outdated", "disabled"])(
  "reinstalls owned %s with one disclosure and sequential fixed commands",
  async (state) => {
    const e = await environment();
    const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
    Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
    await e.service.change(e.input());
    if (state !== "installed") await e.owned(state === "outdated" ? 1 : 3, state !== "disabled");
    expect((await e.status()).actions).toContainEqual({
      id: "reinstall",
      label: "Reinstall plugin",
    });
    e.run.mockClear();
    const confirm = vi.fn((_content: DialogContent) => Promise.resolve(true));
    await e.service.change(e.input("reinstall", confirm));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Reinstall Antigravity plugin?" }),
    );
    expect(JSON.stringify(confirm.mock.calls)).toContain("uninstall");
    expect(e.run.mock.calls.filter((call) => call[1][1] !== "list").map((call) => call[1])).toEqual(
      [
        ["plugin", "uninstall", "foom"],
        ["plugin", "install", expect.stringContaining("agent-plugins")],
      ],
    );
    expect((await e.status()).state).toBe(state === "disabled" ? "disabled" : "installed");
  },
);

it("does not reinstall when removal fails or leaves an owned directory", async () => {
  const e = await environment();
  const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
  Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
  await e.owned(1);
  e.run.mockResolvedValue({ stdout: JSON.stringify({ imports: [] }) });
  await expect(e.service.change(e.input("reinstall"))).rejects.toThrow("command failed");
  expect(e.run.mock.calls.some((call) => call[1][1] === "install")).toBe(false);
  e.run
    .mockRejectedValueOnce(Error("probe failed"))
    .mockRejectedValueOnce(Error("legacy probe failed"));
  expect((await e.status()).state).toBe("unavailable");
});

it.each([
  "cancel",
  "cancel-after-removal",
  "uninstall-fails",
  "install-fails",
  "stage-changes",
  "executable-changes",
])("reinstall fails closed for %s without an automatic retry", async (failure) => {
  const e = await environment();
  const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
  Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
  await e.owned(1);
  const run = e.run.getMockImplementation();
  if (!run) throw Error("Missing fixture runner");
  const controller = new AbortController();
  let staged: Awaited<ReturnType<typeof stagePlugin>> | undefined;
  e.run.mockImplementation(async (executable, args) => {
    if (args[1] === "uninstall" && failure === "uninstall-fails") throw Error("failed");
    if (args[1] === "install" && failure === "install-fails") throw Error("failed");
    const result = await run(executable, args);
    if (args[1] === "uninstall" && failure === "cancel-after-removal") controller.abort();
    if (args[1] === "uninstall" && failure === "stage-changes")
      await writeFile(join(required(staged).directory, "observer.sh"), "changed");
    if (args[1] === "uninstall" && failure === "executable-changes")
      await writeFile(e.executable, "changed executable");
    return result;
  });
  const input = {
    ...e.input("reinstall", () => Promise.resolve(failure !== "cancel")),
    signal: controller.signal,
  };
  input.stage = async () => {
    staged = await stagePlugin(e.m, e.home, {}, process.platform === "win32", e.home);
    return staged;
  };
  if (failure === "cancel") await e.service.change(input);
  else await expect(e.service.change(input)).rejects.toThrow("command failed");
  const mutations = e.run.mock.calls.filter((call) => call[1][1] !== "list");
  expect(mutations.map((call) => call[1][1])).toEqual(
    failure === "cancel"
      ? []
      : failure === "install-fails"
        ? ["uninstall", "install"]
        : ["uninstall"],
  );
  expect((await e.status()).state).toBe(
    ["cancel", "uninstall-fails"].includes(failure) ? "outdated" : "not-installed",
  );
});

it.each(["install", "update", "reinstall"])(
  "keeps every staged byte and computes collapsed %s summaries in main",
  async (action) => {
    const e = await environment();
    if (action === "reinstall") {
      const install = required(e.m.setup?.actions.find((entry) => entry.id === "install"));
      e.m.setup?.actions.push({
        ...install,
        id: "reinstall",
        label: "Reinstall plugin",
        arguments: ["plugin", "reinstall", "{pluginDir}"],
        when: { all: [], any: undefined },
      });
    }
    if (action !== "install") await e.owned(action === "update" ? 1 : 2);
    e.m.files.push({
      name: "unicode.json",
      scope: "plugin",
      format: "json",
      content: '{"text":"é 🌌 <img src=x>"}',
      when: undefined,
    });
    await mkdir(join(e.home, "profile space"));
    const staging = await stagePlugin(
      e.m,
      join(e.home, "profile space"),
      {},
      process.platform === "win32",
      e.home,
    );
    const contents = await Promise.all(
      ["plugin.json", "unicode.json"].map(async (name) => ({
        name,
        content: await readFile(join(staging.directory, name), "utf8"),
      })),
    );
    const confirm = vi.fn((dialog: DialogContent) => {
      const sections = required(dialog.sections);
      expect(
        sections.filter((section) => section.summary === undefined).map((section) => section.label),
      ).toEqual(["Action disclosure", "Instructions and removal"]);
      expect(
        sections.find((section) => section.label === "Status and ownership checks"),
      ).toMatchObject({
        summary: [{ text: "2 metadata checks · 2 ownership requirements" }],
        items: [JSON.stringify(e.m.setup?.status)],
      });
      expect(
        sections.find((section) => section.label === "Staged files (JSON-escaped bytes)"),
      ).toMatchObject({
        summary: [
          {
            text: `2 files · ${String(contents.reduce((total, file) => total + Buffer.byteLength(file.content), 0))} bytes`,
          },
          ...contents.map((file) => ({
            text: `${file.name} · ${createHash("sha256").update(file.content).digest("hex").slice(0, 12)} · ${String(Buffer.byteLength(file.content))} B`,
            title: `${file.name} · SHA-256 ${createHash("sha256").update(file.content).digest("hex")} · ${String(Buffer.byteLength(file.content))} B`,
          })),
        ],
        items: contents.map(
          (file) =>
            `${file.name} · SHA-256 ${createHash("sha256").update(file.content).digest("hex")}\n${file.name}: ${JSON.stringify(file.content)}`,
        ),
      });
      const executableSection = required(
        sections.find((section) => section.label === "Executable and fixed arguments"),
      );
      const command = required(executableSection.summary?.[0]);
      const expectedCommand =
        action === "reinstall"
          ? `fixture-cli plugin uninstall foom; fixture-cli plugin install ${JSON.stringify(staging.directory)}`
          : `fixture-cli plugin install ${JSON.stringify(staging.directory)}`;
      const fullExecutable = /[\s"\\]/u.test(e.executable)
        ? JSON.stringify(e.executable)
        : e.executable;
      expect(command.title).toBe(expectedCommand.replaceAll("fixture-cli", fullExecutable));
      expect(command.text).toBe(`${expectedCommand.slice(0, 38)}…${expectedCommand.slice(-29)}`);
      expect(command.text).not.toMatch(/[\r\n]/u);
      expect(executableSection.items).toContain(e.executable);
      expect(sections.find((section) => section.label === "Installation and state")).toMatchObject({
        summary: [
          {
            text: `setup-fixture · ~/.gemini/config/plugins/foom · ${action === "install" ? "not-installed" : action === "update" ? "outdated" : "installed"}`,
          },
        ],
        items: [
          "setup-fixture",
          "~/.gemini/config/plugins/foom",
          action === "install" ? "not-installed" : action === "update" ? "outdated" : "installed",
          expect.any(String),
        ],
      });
      return Promise.resolve(false);
    });
    await e.service.change({ ...e.input(action, confirm), stage: () => Promise.resolve(staging) });
    expect(confirm).toHaveBeenCalledOnce();
    expect(e.run.mock.calls.every((entry) => entry[1][1] === "list")).toBe(true);
  },
);

it("distinguishes absolute executables with the same basename in command titles", async () => {
  const e = await environment();
  const dialogs: DialogContent[] = [];
  for (const directory of ["first", "second"]) {
    const parent = join(e.home, directory);
    await mkdir(parent);
    const executable = join(parent, "fixture-cli");
    await writeFile(executable, "fixture executable");
    await e.service.change({
      ...e.input("install", (dialog) => {
        dialogs.push(dialog);
        return Promise.resolve(false);
      }),
      executable,
    });
  }
  const commands = dialogs.map((dialog) =>
    required(
      dialog.sections?.find((section) => section.label === "Executable and fixed arguments")
        ?.summary?.[0],
    ),
  );
  expect(commands[0]?.text).toBe(commands[1]?.text);
  expect(commands[0]?.title).not.toBe(commands[1]?.title);
  for (const [index, directory] of ["first", "second"].entries()) {
    const executable = join(e.home, directory, "fixture-cli");
    const quoted = /[\s"\\]/u.test(executable) ? JSON.stringify(executable) : executable;
    expect(commands[index]?.title).toContain(`${quoted} plugin install `);
  }
});

it.each(
  [
    "\0",
    "\n",
    "\r",
    "\t",
    "\u0085",
    "\u2028",
    "\u2029",
    ...Array.from({ length: 5 }, (_, i) => String.fromCodePoint(0x202a + i)),
    ...Array.from({ length: 4 }, (_, i) => String.fromCodePoint(0x2066 + i)),
    "\u200e",
    "\u200f",
    "x".repeat(8193),
    "x".repeat(1024 * 1024),
  ].map((value, index) => ({ value, index })),
)("refuses unsafe main summary $index before confirmation", async ({ value }) => {
  const e = await environment();
  const staging = await e.input().stage();
  for (const field of ["text", "title"] as const) {
    const confirm = vi.fn(() => Promise.resolve(false));
    await expect(
      e.service.change({
        ...e.input("install", confirm),
        stage: () => Promise.resolve({ ...staging, summary: [{ text: "safe", [field]: value }] }),
      }),
    ).rejects.toThrow("Invalid plugin confirmation summary");
    expect(confirm).not.toHaveBeenCalled();
  }
});

it("refuses executable bidi controls before formatting the command", async () => {
  const e = await environment();
  const parent = join(e.home, "alternate\u202e");
  await mkdir(parent);
  const executable = join(parent, "fixture-cli");
  await writeFile(executable, "fixture executable");
  const confirm = vi.fn(() => Promise.resolve(false));
  await expect(e.service.change({ ...e.input("install", confirm), executable })).rejects.toThrow(
    "Invalid plugin confirmation summary",
  );
  expect(confirm).not.toHaveBeenCalled();
});
