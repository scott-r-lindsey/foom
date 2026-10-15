import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
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
      const content = await readFile(join(required(args[2]), "plugin.json"), "utf8");
      await mkdir(directory, { recursive: true });
      await writeFile(manifest, content);
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
    stage: () => stagePlugin(m, home, {}),
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
it("rejects changed approval, executable, ownership and state after confirmation", async () => {
  for (const change of ["approval", "executable", "ownership", "state", "stage"]) {
    const e = await environment();
    let approved = true;
    const input = e.input("install", async () => {
      if (change === "approval") approved = false;
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
      if (!approved) throw Error("Approval revoked");
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
  const stage = await stagePlugin(e.m, e.home, {});
  expect((await stagePlugin(e.m, e.home, {})).directory).toBe(stage.directory);
  await stage.verify();
  await writeFile(join(stage.directory, "config/hooks.json"), "[]");
  await expect(stage.verify()).rejects.toThrow("changed");
  e.m.files = [];
  await expect(stagePlugin(e.m, e.home, {})).rejects.toThrow("Missing");
  e.m.files = [
    {
      name: "plugin.json",
      scope: "plugin",
      format: "json",
      content: '{"version":{observerVersion:lifecycle}}',
      when: undefined,
    },
  ];
  await expect(stagePlugin(e.m, e.home, {})).rejects.toThrow("Unselected");
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
  const stage = await stagePlugin(e.m, e.home, {});
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
    const staged = await stagePlugin(e.m, e.home, {});
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
  "recognizes legacy bundled observer version %s without a fingerprint or reinstall",
  async (version) => {
    const e = await environment();
    const { default: bundled } = await import("../../../../src/shared/bundled-agents/agy.json");
    Object.assign(e.m, parseAgentManifest(JSON.stringify(bundled), "bundled").model);
    await e.owned(version);
    expect(await e.status()).toMatchObject({ state: version < 2 ? "outdated" : "installed" });
    if (version >= 2) {
      expect((await e.status()).actions).toEqual([{ id: "remove", label: "Remove" }]);
      await expect(e.service.change(e.input("update"))).rejects.toThrow("changed");
    }
    expect(e.run.mock.calls.every((entry) => entry[1][1] === "list")).toBe(true);
    expect(await readFile(e.manifest, "utf8")).toBe(
      JSON.stringify({ name: "foom", foomObserverVersion: version }),
    );
  },
);

it("preserves installed native observer and hook bytes on both platforms; only staging metadata is added", async () => {
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
          foomObserverVersion: 2,
          foomStagingFingerprint: staged.fingerprint,
        });
      } else if (windows || name === "hooks.json" || name === "observer.sh")
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
