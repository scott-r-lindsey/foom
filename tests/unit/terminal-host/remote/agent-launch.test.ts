import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tomlContainer } from "../../../../src/shared/agent-manifest-container";
import { record } from "../../../../src/shared/remote-agent-protocol";
import { endpointRequest } from "../../../../src/terminal-host/remote/agent-endpoint";
import {
  prepareRemoteAgent,
  remoteMcpArgument,
  remoteMcpFile,
  stageRemotePlugin,
} from "../../../../src/terminal-host/remote/agent-launch";
import {
  hostDiscovery,
  remoteCheckout,
} from "../../../../src/terminal-host/remote/agent-discovery";
vi.mock("../../../../src/terminal-host/remote/agent-discovery", () => ({
  hostEnvironment: () => ({ PATH: "/fixture" }),
  remoteCheckout: vi.fn(() => Promise.resolve("identity")),
  hostDiscovery: vi.fn(() =>
    Promise.resolve({
      command: "/fixture/claude",
      env: { PATH: "/fixture" },
      version: "2.1.293 (Claude Code)",
      help: "--settings --mcp-config --prompt-interactive -c --no-alt-screen",
    }),
  ),
  hostProbe: vi.fn(() => Promise.resolve("[]")),
}));
let home: string;
const endpoints: { dispose(): void }[] = [];
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "ra-")));
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) endpoint.dispose();
  vi.mocked(remoteCheckout).mockReset().mockResolvedValue("identity");
  await rm(home, { recursive: true, force: true });
});
const spec = {
  agent: "claude",
  repository: "/repo",
  worktree: "/worktree",
  defaults: [],
  hooks: true,
  prompt: "Do the task",
};
const call = () => Promise.resolve({ type: "error" as const, error: "unavailable" as const });
test.skipIf(process.platform === "win32")(
  "remote Claude uses host discovery, private stdio MCP and reduced hooks without hub credentials or terminal IDs",
  async () => {
    const prepared = await prepareRemoteAgent(spec, "/fixture/shell", home, () => {}, call);
    endpoints.push(prepared.endpoint);
    expect(prepared.spec.command).toBe("/fixture/claude");
    expect(hostDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude" }),
      "/fixture/shell",
      home,
    );
    expect(remoteCheckout).toHaveBeenCalledTimes(2);
    expect(prepared.ready).toMatchObject({ hooks: true, mcp: true, channels: ["lifecycle"] });
    const args = [...prepared.spec.args];
    const path = args[args.indexOf("--mcp-config") + 1];
    if (!path) throw new Error("No private MCP config");
    const config: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(JSON.stringify(config)).toContain('"command"');
    expect(JSON.stringify(config)).toContain("--mcp");
    expect(JSON.stringify(config)).toContain("${FOOM_REMOTE_SOCKET}");
    expect(JSON.stringify(config)).toContain("${FOOM_REMOTE_TOKEN}");
    expect(JSON.stringify(config)).not.toContain(prepared.endpoint.token);
    expect(JSON.stringify(config)).not.toContain("http:");
    expect(prepared.spec.env).toMatchObject({ FOOM_REMOTE_SOCKET: prepared.endpoint.socket });
    for (const name of [
      "FOOM_SESSION",
      "FOOM_CONTROL_URL",
      "FOOM_CONTROL_TOKEN",
      "FOOM_CONTROL_INSTANCE",
      "FOOM_TERMINAL_ID",
    ])
      expect(prepared.spec.env).not.toHaveProperty(name);
    expect(args.join(" ")).toContain("--observe");
    expect(args.join(" ")).not.toContain(prepared.endpoint.token);
    expect(args.join(" ")).not.toContain(prepared.endpoint.hookToken);
    expect(args.join(" ")).toContain("__handoff");
    const result = await prepareRemoteAgent(
      { ...spec, hooks: false, conversationId: "existing" },
      "/fixture/shell",
      home,
      () => {},
      call,
    );
    endpoints.push(result.endpoint);
    expect(result.ready).toMatchObject({ hooks: false, conversationId: "existing" });
    expect(result.spec.args).toContain("--resume");
  },
);
test.skipIf(process.platform === "win32")(
  "remote Codex uses its additive stdio table, notifier fallback, no-alt-screen and conversation resume",
  async () => {
    vi.mocked(hostDiscovery).mockResolvedValueOnce({
      command: "/fixture/codex",
      env: { PATH: "/fixture" },
      version: "codex-cli 0.161.0",
      help: "-c --no-alt-screen",
    });
    const prepared = await prepareRemoteAgent(
      { ...spec, agent: "codex", conversationId: "existing", defaults: ["--verbose"] },
      "/fixture/shell",
      home,
      () => {},
      call,
    );
    endpoints.push(prepared.endpoint);
    expect(prepared.ready).toMatchObject({ hooks: true, mcp: true, conversationId: "existing" });
    expect(prepared.spec.args).toContain("--no-alt-screen");
    expect(prepared.spec.args).toContain("resume");
    expect(
      prepared.spec.args.some(
        (arg) =>
          arg.startsWith("mcp_servers.") &&
          arg.includes("command=") &&
          arg.includes("--mcp") &&
          !arg.includes("url="),
      ),
    ).toBe(true);
    const attachment = prepared.spec.args.find((arg) => arg.startsWith("mcp_servers."));
    if (!attachment) throw new Error("No Codex MCP attachment");
    const table = tomlContainer(attachment.slice(attachment.indexOf("=") + 1), "fixture");
    if (!record(table) || !Array.isArray(table["env_vars"]))
      throw new Error("No Codex environment allowlist");
    expect(table["env_vars"]).toEqual(["FOOM_REMOTE_SOCKET", "FOOM_REMOTE_TOKEN"]);
    const filtered: Record<string, string> = {};
    for (const name of table["env_vars"]) {
      if (typeof name !== "string") throw new Error("Invalid environment name");
      const value = prepared.spec.env?.[name];
      if (value !== undefined) filtered[name] = value;
    }
    expect(filtered).not.toHaveProperty("FOOM_REMOTE_HOOK_TOKEN");
    prepared.endpoint.activate();
    await expect(
      endpointRequest("/call", { method: "whoami", params: {} }, filtered),
    ).resolves.toEqual({
      type: "error",
      error: "unavailable",
    });
    expect(attachment).not.toContain(prepared.endpoint.token);
    expect(prepared.spec.args.some((arg) => arg.startsWith("notify="))).toBe(true);
  },
);
test.skipIf(process.platform === "win32")(
  "unverified discovery and disabled hooks retain output evaluation; failures remove private endpoints",
  async () => {
    vi.mocked(hostDiscovery).mockResolvedValueOnce({
      command: "/fixture/claude",
      env: { PATH: "/fixture" },
      version: "custom",
      help: "",
    });
    const prepared = await prepareRemoteAgent(
      {
        agent: spec.agent,
        repository: spec.repository,
        worktree: spec.worktree,
        defaults: [],
        hooks: true,
      },
      "/fixture/shell",
      home,
      () => {},
      call,
    );
    endpoints.push(prepared.endpoint);
    expect(prepared.ready).toMatchObject({ hooks: false, mcp: false });
    expect(prepared.spec.args).not.toContain("--mcp-config");
    await expect(
      prepareRemoteAgent(
        { ...spec, defaults: ["--dangerously-skip-permissions"] },
        "/fixture/shell",
        home,
        () => {},
        call,
      ),
    ).rejects.toThrow("bypass");
    await expect(
      prepareRemoteAgent({ ...spec, agent: "unknown" }, "/fixture/shell", home, () => {}, call),
    ).rejects.toThrow("unavailable");
    vi.mocked(remoteCheckout).mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    await expect(prepareRemoteAgent(spec, "/fixture/shell", home, () => {}, call)).rejects.toThrow(
      "changed",
    );
    vi.mocked(hostDiscovery).mockResolvedValueOnce({
      command: "/fixture/codex",
      env: { PATH: "/fixture" },
      version: "custom",
      help: "",
    });
    // A version without prompt support fails closed rather than typing the task into a PTY.
    await expect(
      prepareRemoteAgent({ ...spec, agent: "agy" }, "/fixture/shell", home, () => {}, call),
    ).rejects.toThrow();
  },
);
test.skipIf(process.platform === "win32")(
  "Antigravity stages opt-in assets without installing them, and attaches only a current enabled remote plugin",
  async () => {
    const path = await stageRemotePlugin("agy", home);
    const metadata: unknown = JSON.parse(await readFile(join(path, "plugin.json"), "utf8"));
    expect(metadata).toMatchObject({ name: "foom", foomObserverVersion: 4 });
    const hooks = await readFile(join(path, "hooks.json"), "utf8");
    expect(hooks).toContain("--observe");
    expect(hooks).not.toContain("TOKEN");
    await expect(stageRemotePlugin("claude", home)).rejects.toThrow("No bundled");
    const directory = join(home, ".gemini/config/plugins/foom");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "plugin.json"), JSON.stringify(metadata));
    await writeFile(
      join(home, ".gemini/config/config.json"),
      '{"plugins":{"foom":{"enabled":true}}}',
    );
    vi.mocked(hostDiscovery).mockResolvedValue({
      command: "/fixture/agy",
      env: { PATH: "/fixture" },
      version: "1.4.2",
      help: "--prompt-interactive",
    });
    const prepared = await prepareRemoteAgent(
      { ...spec, agent: "agy" },
      "/fixture/shell",
      home,
      () => {},
      call,
    );
    endpoints.push(prepared.endpoint);
    expect(prepared.ready).toMatchObject({ hooks: true, mcp: false });
    expect(prepared.spec.args.join(" ")).toContain("#756");
    await writeFile(
      join(home, ".gemini/config/config.json"),
      '{"plugins":{"foom":{"enabled":false}}}',
    );
    const disabled = await prepareRemoteAgent(
      { ...spec, agent: "agy" },
      "/fixture/shell",
      home,
      () => {},
      call,
    );
    endpoints.push(disabled.endpoint);
    expect(disabled.ready.hooks).toBe(false);
    await rm(join(home, ".gemini/config/config.json"));
    const implicit = await prepareRemoteAgent(
      { ...spec, agent: "agy" },
      "/fixture/shell",
      home,
      () => {},
      call,
    );
    endpoints.push(implicit.endpoint);
    expect(implicit.ready.hooks).toBe(true);
  },
);
test("MCP conversion refuses unexpected data and never rewrites unrelated user configuration", () => {
  expect(remoteMcpArgument("-c", "/helper")).toBe("-c");
  expect(remoteMcpArgument("setting=value", "/helper")).toBe("setting=value");
  expect(() =>
    remoteMcpArgument(
      'name={url="http://127.0.0.1:1/mcp",bearer_token_env_var="OTHER"}',
      "/helper",
    ),
  ).toThrow();
  expect(() => remoteMcpFile("[]", "/helper", "name")).toThrow();
  expect(() => remoteMcpFile('{"mcpServers":{}}', "/helper", "name")).toThrow();
});
