import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  mkdir,
  chmod,
  link,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import data from "../../../../src/shared/bundled-agents/codex.json";
import { bundledProvider } from "../../../../src/main/agents/providers/bundled";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import {
  installedHealth,
  installedObserverPath,
} from "../../../../src/main/agents/providers/installed-observers";
import { prepareHookLaunch } from "../../../../src/main/agents/hook-launch";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { codexHookArguments, codexObserverCommand } from "../../../helpers/legacy-codex";
import type { AgentLaunch } from "../../../../src/shared/agents";
import { V2ExecutionHooks, V2Health } from "../../../../src/main/agents/providers/v2-health";

const provider = agentProvider("codex");
const model = provider.model;
if (!model) throw new Error("Missing bundled model");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await expect
      .poll(async () =>
        (await readdir(directory)).filter((name) => name.startsWith("foom-v2-hooks-")),
      )
      .toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
});

async function directory() {
  const result = await mkdtemp(join(tmpdir(), "foom-bundled-"));
  directories.push(result);
  return result;
}
const request: AgentLaunch = {
  agent: "codex",
  repository: "/repo",
  worktree: "/repo",
  cols: 80,
  rows: 24,
};
const receiver = {
  register: vi.fn(() => ({
    env: {
      FOOM_SESSION: "session",
      FOOM_TOKEN: "token",
      FOOM_HOOK_URL: "http://127.0.0.1:1/hooks",
    },
    revoke: vi.fn(),
  })),
};

it.each(["linux", "win32"] as const)(
  "retains all six trusted definition bytes on %s across launches",
  async (platform) => {
    const scratch = await directory();
    const installation = provider.discover(
      "/fixture/codex",
      "codex-cli 0.161.0",
      "-c --no-alt-screen",
    );
    const first = await prepareHookLaunch(
      receiver,
      "codex",
      vi.fn(),
      platform,
      scratch,
      () => Promise.resolve({ stdout: "", stderr: "" }),
      scratch,
    );
    const second = await prepareHookLaunch(
      receiver,
      "codex",
      vi.fn(),
      platform,
      scratch,
      () => Promise.resolve({ stdout: "", stderr: "" }),
      scratch,
    );
    try {
      const expected = codexHookArguments(codexObserverCommand(platform));
      const prepared = await provider.prepareLaunch?.(
        installation,
        request,
        [],
        undefined,
        false,
        true,
        first,
      );
      expect(first.v2?.values["observerCommand:lifecycle"]).toBe(codexObserverCommand(platform));
      expect(second.v2?.values["observerCommand:lifecycle"]).toBe(
        first.v2?.values["observerCommand:lifecycle"],
      );
      expect(prepared?.args.slice(1, 13)).toEqual(expected);
      expect(prepared?.args[0]).toBe("--no-alt-screen");
      expect(prepared?.args.slice(13)).toEqual([
        "-c",
        `notify=${JSON.stringify(first.v2?.values["observerArgv:notify"])}`,
      ]);
      expect(expected.join(" ")).not.toMatch(/FOOM_|token|http:|foom-v2/u);
      prepared?.dispose();
    } finally {
      first.dispose();
      second.dispose();
    }
  },
);

it.each(["/opt/Foom it's/observers", "C:/Foom it's $safe/observers"])(
  "matches the old platform serializers in %s",
  (root) => {
    const channel = model.hooks?.channels[0];
    if (!channel) throw new Error("Missing channel");
    for (const windows of [false, true]) {
      const command = codexObserverCommand(windows ? "win32" : "linux", root);
      const path = installedObserverPath(channel, windows, root);
      expect(path).toContain(windows ? "codex-v2.ps1" : "codex-v1.sh");
      // Also exercise the engine serializer against the independently retained legacy ABI.
      expect(
        observerInvocation(path, channel.observer.commandArguments, windows, true).command,
      ).toBe(command);
    }
  },
);
import { observerInvocation } from "../../../../src/main/agents/providers/v2-observers";

it.each(["trusted", "declined", "outdated", "not-reviewed"] as const)(
  "retains existing %s profile health only for exact definitions",
  async (state) => {
    const profile = await directory();
    const definitions = codexHookArguments(codexObserverCommand());
    const file = join(profile, "codex-hook-health.json");
    await writeFile(file, JSON.stringify({ fingerprint: digest(definitions), state }), {
      mode: 0o600,
    });
    const health = await installedHealth(model, profile);
    expect(health.get()).toBe(state);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      fingerprint: digest(definitions),
      state,
    });
    const changed = structuredClone(model);
    const channel = changed.hooks?.channels[0];
    if (!channel) throw new Error("Missing channel");
    channel.arguments[1] = channel.arguments[1]?.replace("timeout=3", "timeout=2") ?? "";
    expect((await installedHealth(changed, profile)).get()).toBe("outdated");
  },
);

it.each([
  "{}",
  "null",
  "{",
  '{"fingerprint":"changed","state":"trusted"}',
  '{"fingerprint":0,"state":"trusted"}',
])("fails closed on invalid legacy health %s", async (content) => {
  const profile = await directory();
  await writeFile(join(profile, "codex-hook-health.json"), content, { mode: 0o600 });
  expect((await installedHealth(model, profile)).get()).not.toBe("trusted");
});

it.skipIf(process.platform === "win32")("does not import health through a symlink", async () => {
  const profile = await directory();
  const target = join(profile, "external");
  await writeFile(
    target,
    JSON.stringify({
      fingerprint: digest(codexHookArguments(codexObserverCommand())),
      state: "trusted",
    }),
    { mode: 0o600 },
  );
  await symlink(target, join(profile, "codex-hook-health.json"));
  expect((await installedHealth(model, profile)).get()).toBe("not-reviewed");
});

it("keeps consent bound to the reviewed build revision and never lends it to config copies", async () => {
  expect(provider.legacyChannelConsent).toBe(true);
  const changed = { ...data, name: "Revised Codex" };
  expect(
    bundledProvider(changed, "codex", digest(changed), digest(data)).legacyChannelConsent,
  ).toBe(false);
  expect(() => bundledProvider(changed, "codex", digest(data))).toThrow("integrity");
  expect(() => bundledProvider(data, "wrong", digest(data))).toThrow("identity");
  expect(() => parseAgentManifest(JSON.stringify(data))).toThrow("reserved-id");
  const copy = v2Provider(
    parseAgentManifest(JSON.stringify({ ...data, id: "codex-custom" })).model,
    () => Promise.resolve(),
  );
  expect(copy.origin).toBe("config");
  expect(copy.legacyChannelConsent).toBeUndefined();
  expect(copy.model?.hooks).toEqual(model.hooks);
  expect(copy.model?.setup).toEqual(model.setup);
  expect(copy.model?.bypassArguments).toEqual(model.bypassArguments);
  expect(copy.resume("existing-session")).toEqual(["resume", "existing-session"]);
  const profile = await directory();
  const health = await installedHealth(model, profile);
  health.set("trusted");
  await health.flush();
  expect((await installedHealth(copy.model ?? model, profile)).get()).toBe("not-reviewed");
});

it("preserves resume/default/MCP/observer/prompt order without widening tool grants", async () => {
  const installation = provider.discover(
    "/fixture/codex",
    "codex-cli 0.161.0",
    "-c --no-alt-screen",
  );
  const scratch = await directory();
  const hooks = await prepareHookLaunch(
    receiver,
    "codex",
    vi.fn(),
    "linux",
    scratch,
    undefined,
    scratch,
  );
  const control = {
    env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1", FOOM_CONTROL_TOKEN: "secret" },
    bind: vi.fn(),
    dispose: vi.fn(),
  };
  try {
    const prepared = await provider.prepareLaunch?.(
      installation,
      { ...request, conversationId: "existing-session", prompt: "Fix it" },
      ["--model", "test"],
      control,
      false,
      true,
      hooks,
    );
    const args = prepared?.args ?? [];
    expect(args.slice(0, 6)).toEqual([
      "resume",
      "existing-session",
      "--model",
      "test",
      "--no-alt-screen",
      "-c",
    ]);
    const attachment = args[6] ?? "";
    expect(prepared?.mcpArguments).toEqual(["-c", attachment]);
    const name = attachment.match(/^mcp_servers\.(foom_[a-f0-9]+)=/u)?.[1];
    if (!name) throw new Error("Missing MCP name");
    expect(attachment).toBe(
      `mcp_servers.${name}={url="http://127.0.0.1:1234/mcp",bearer_token_env_var="FOOM_CONTROL_TOKEN"}`,
    );
    expect(args.slice(7, 19)).toEqual(codexHookArguments(codexObserverCommand("linux")));
    expect(args.slice(-2)).toEqual([
      "--",
      "Task from your Foom orchestrator (another agent, not the user):\n\nFix it",
    ]);
    expect(args.join(" ")).not.toMatch(/secret|enabled_tools|allowedTools/u);
  } finally {
    hooks.dispose();
  }
});

it("never reclassifies duplicate completion and retains notify in the establishing launch", async () => {
  const profile = await directory();
  const health = new V2Health(profile, "test", "definition");
  const channels = new Map((model.hooks?.channels ?? []).map((channel) => [channel.id, channel]));
  const runtime = new V2ExecutionHooks(model, channels, health);
  const accept = (
    caseId: string,
    channel: string,
    action: "ready" | "working" | "classify",
    turn: number,
  ) =>
    runtime.accept(
      {
        terminalId: "t",
        signal: `plugin:codex:${caseId}`,
        caseId,
        channel,
        action,
        endsTurn: action === "classify",
      },
      turn,
    );
  expect(accept("SessionStart", "lifecycle", "ready", 0)).toBe(false);
  accept("UserPromptSubmit", "lifecycle", "working", 1);
  expect(accept("Stop", "lifecycle", "classify", 1)).toBe(true);
  expect(health.get()).toBe("trusted");
  expect(accept("agent-turn-complete", "notify", "classify", 1)).toBe(false);
  expect(channels.has("notify")).toBe(true);
  expect(accept("agent-turn-complete", "notify", "classify", 2)).toBe(true);
  expect(health.get()).toBe("declined");
  await health.flush();
});

it("shares config-copy health with the launch engine while keeping its paths and observations separate", async () => {
  const { observerHealth } = await import(
    "../../../../src/main/agents/providers/installed-observers"
  );
  const { prepareV2Hooks } = await import("../../../../src/main/agents/providers/v2-hook-launch");
  const profile = await directory();
  const copy = v2Provider(
    parseAgentManifest(JSON.stringify({ ...data, id: "codex-copy" })).model,
    () => Promise.resolve(),
  );
  const hooks = await prepareV2Hooks(
    receiver,
    copy.model ?? model,
    vi.fn(),
    false,
    profile,
    profile,
  );
  try {
    const health = await observerHealth(copy.model ?? model, profile, false, false);
    expect(health).toBe(hooks.v2?.runtime?.health);
    expect(hooks.v2?.values["observerCommand:lifecycle"]).not.toBe(codexObserverCommand("linux"));
    health.set("trusted");
    await health.flush();
    expect((await installedHealth(model, profile)).get()).toBe("not-reviewed");
  } finally {
    hooks.dispose();
  }
});

it("does not infer health or observer definitions when channels are absent", async () => {
  const { observerHealth } = await import(
    "../../../../src/main/agents/providers/installed-observers"
  );
  const empty = structuredClone(model);
  empty.hooks = undefined;
  empty.health = undefined;
  const profile = await directory();
  expect((await installedHealth(empty, profile)).get()).toBe("not-reviewed");
  expect((await observerHealth(empty, profile, false)).get()).toBe("not-reviewed");
});

it.each([
  "directory",
  "oversize",
  "hardlink",
  ...(process.platform === "win32" ? [] : ["permissions"]),
])("rejects an unsafe legacy profile health entry: %s", async (kind) => {
  const profile = await directory();
  const file = join(profile, "codex-hook-health.json");
  if (kind === "directory") await mkdir(file);
  else {
    const trusted = JSON.stringify({
      fingerprint: digest(codexHookArguments(codexObserverCommand())),
      state: "trusted",
    });
    await writeFile(file, trusted + (kind === "oversize" ? " ".repeat(4097) : ""), { mode: 0o600 });
    if (kind === "hardlink") await link(file, join(profile, "other"));
    if (kind === "permissions" && process.platform !== "win32") await chmod(file, 0o644);
  }
  expect((await installedHealth(model, profile)).get()).toBe("not-reviewed");
});

it("never falls back to old trusted health after a new private record is corrupt or stale", async () => {
  const profile = await directory();
  const definitions = codexHookArguments(codexObserverCommand());
  await writeFile(
    join(profile, "codex-hook-health.json"),
    JSON.stringify({ fingerprint: digest(definitions), state: "trusted" }),
    { mode: 0o600 },
  );
  const migrated = await installedHealth(model, profile);
  expect(migrated.get()).toBe("trusted");
  const root = join(profile, `foom-observers-${String(userInfo().uid)}`);
  const file = join(root, "codex-health.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    fingerprint: digest(definitions),
    state: "trusted",
  });
  await writeFile(file, "{");
  const corrupt = new V2Health(
    root,
    "codex",
    digest(definitions),
    join(profile, "codex-hook-health.json"),
  );
  await corrupt.load();
  expect(corrupt.get()).toBe("not-reviewed");
  await writeFile(file, JSON.stringify({ fingerprint: "stale", state: "trusted" }));
  const stale = new V2Health(
    root,
    "codex",
    digest(definitions),
    join(profile, "codex-hook-health.json"),
  );
  await stale.load();
  expect(stale.get()).toBe("outdated");
});
