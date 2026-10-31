import type { HookSignal } from "../../../../src/shared/hooks";
import {
  remotePiExtension,
  assertRemotePiIntegrity,
} from "../../../../src/terminal-host/remote/pi-extension";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
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
      undefined,
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
  "remote Copilot stages its invocation plugin and restricted stdio MCP after host discovery",
  async () => {
    vi.mocked(hostDiscovery).mockResolvedValueOnce({
      command: "/fixture/copilot",
      env: { PATH: "/fixture" },
      version: "GitHub Copilot CLI 1.0.103.",
      help: "--plugin-dir --additional-mcp-config --allow-tool --interactive --session-id --resume",
    });
    const prepared = await prepareRemoteAgent(
      { ...spec, agent: "copilot" },
      "/fixture/shell",
      home,
      () => {},
      call,
    );
    endpoints.push(prepared.endpoint);
    expect(prepared.ready).toMatchObject({ hooks: true, mcp: true, channels: ["lifecycle"] });
    expect(prepared.spec.command).toBe("/fixture/copilot");
    expect(prepared.spec.args).toContain("--plugin-dir");
    expect(prepared.spec.args).toContain("--session-id");
    const hooks = await readFile(join(prepared.endpoint.directory, "hooks.json"), "utf8");
    expect(hooks).toContain("--observe");
    expect(hooks).toContain("preToolUse");
    const mcp = await readFile(join(prepared.endpoint.directory, "mcp.json"), "utf8");
    expect(mcp).toContain("--mcp");
    expect(mcp).not.toContain("FOOM_CONTROL_TOKEN");
    expect(mcp).not.toContain(prepared.endpoint.token);
    expect(mcp).not.toContain(prepared.endpoint.hookToken);
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
    ).rejects.toMatchObject({ reason: "remote_agent_unsupported" });
    vi.mocked(remoteCheckout).mockRejectedValueOnce(new Error("PRIVATE git output"));
    await expect(
      prepareRemoteAgent(spec, "/fixture/shell", home, () => {}, call),
    ).rejects.toMatchObject({ reason: "remote_worktree_unavailable" });
    vi.mocked(remoteCheckout).mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    await expect(prepareRemoteAgent(spec, "/fixture/shell", home, () => {}, call)).rejects.toThrow(
      "worktree",
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
    expect(prepared.spec.args.join(" ")).toContain("unavailable to remote children");
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

test.skipIf(process.platform === "win32").each(["pi", "opencode"])(
  "remote %s stages private attachments, prompt, resume and independent hook selection",
  async (agent) => {
    for (const hooks of [true, false]) {
      vi.mocked(hostDiscovery).mockResolvedValueOnce({
        command: `/fixture/${agent}`,
        env: { PATH: "/fixture" },
        version: agent === "pi" ? "1.4.0" : "opencode v2.0.32",
        help: "--extension --session-id --session --standalone --prompt",
      });
      const prepared = await prepareRemoteAgent(
        {
          ...spec,
          agent,
          hooks,
          conversationId: "ses_existing",
          defaults: ["--model", "fixture/model"],
        },
        "/fixture/shell",
        home,
        () => {},
        call,
      );
      endpoints.push(prepared.endpoint);
      expect(prepared.ready).toMatchObject({ hooks, mcp: true, conversationId: "ses_existing" });
      expect(prepared.spec.args).toContain("--session");
      expect(prepared.spec.args).toContain("ses_existing");
      expect(prepared.spec.args).toContain("fixture/model");
      expect(prepared.spec.args.join(" ")).toContain(spec.prompt);
      if (agent === "pi") {
        const file = prepared.spec.args[prepared.spec.args.indexOf("--extension") + 1];
        expect(file).toBe(join(prepared.endpoint.directory, "extension/pi-remote-v1.mjs"));
        expect(await readFile(file ?? "", "utf8")).toContain("registerMcpServer");
        expect(
          JSON.parse(
            await readFile(join(prepared.endpoint.directory, "extension/launch.json"), "utf8"),
          ),
        ).toMatchObject(hooks ? { channel: "lifecycle", mcp: {} } : { mcp: {} });
      } else {
        const config: unknown = JSON.parse(prepared.spec.env?.["OPENCODE_CONFIG_CONTENT"] ?? "");
        expect(config).toMatchObject({ mcp: { servers: {} } });
        if (!record(config)) throw new Error("Invalid config");
        expect(Array.isArray(config["permissions"])).toBe(true);
        const content = JSON.stringify(config);
        expect(content).toContain('"type":"local"');
        expect(content).toContain("--mcp");
        expect(content).not.toContain(prepared.endpoint.token);
        expect(content).not.toContain("http:");
        expect(content).not.toContain("_launch");
        expect(prepared.spec.env?.["OPENCODE_CONFIG"]).toBe(
          hooks ? join(prepared.endpoint.directory, "hooks.json") : undefined,
        );
      }
      prepared.endpoint.dispose();
      await expect(readFile(join(prepared.endpoint.directory, "s"))).rejects.toThrow();
      await expect(
        endpointRequest("/call", { method: "whoami", params: {} }, prepared.spec.env),
      ).rejects.toThrow();
    }
  },
);

test("a registered worktree's creation identity is checked before agent discovery or preparation", async () => {
  vi.mocked(hostDiscovery).mockClear();
  await expect(
    prepareRemoteAgent(
      { ...spec, checkoutIdentity: "a".repeat(64) },
      "/fixture/shell",
      home,
      () => {},
      call,
    ),
  ).rejects.toMatchObject({ reason: "remote_worktree_unavailable" });
  expect(hostDiscovery).not.toHaveBeenCalled();
});

test.skipIf(process.platform === "win32")(
  "a prepared agent rechecks its captured identity immediately before start",
  async () => {
    const prepared = await prepareRemoteAgent(
      {
        ...spec,
        hooks: false,
        checkoutIdentity: createHash("sha256").update("identity").digest("hex"),
      },
      "/fixture/shell",
      home,
      () => {},
      call,
    );
    endpoints.push(prepared.endpoint);
    await prepared.validate();
    vi.mocked(remoteCheckout).mockResolvedValueOnce("replaced");
    await expect(prepared.validate()).rejects.toMatchObject({
      reason: "remote_worktree_unavailable",
    });
  },
);

test.skipIf(process.platform === "win32").each(["pi", "opencode"])(
  "fixture %s consumes generated module and sends reduced lifecycle events over the private socket",
  async (agent) => {
    vi.mocked(hostDiscovery).mockResolvedValueOnce({
      command: process.execPath,
      env: { PATH: "/fixture" },
      version: agent === "pi" ? "1.4.0" : "opencode v2.0.32",
      help: "--extension --session-id --session --standalone --prompt",
    });
    const signal = vi.fn<(signal: HookSignal) => void>();
    const relay = vi.fn(() =>
      Promise.resolve({
        type: "identity" as const,
        alias: "11111111-1111-4111-8111-111111111111",
        role: "child" as const,
        capabilities: ["whoami", "manual", "handoff"],
      }),
    );
    const prepared = await prepareRemoteAgent(
      { ...spec, agent },
      "/fixture/shell",
      home,
      signal,
      relay,
    );
    endpoints.push(prepared.endpoint);
    prepared.endpoint.activate();
    const conversation = prepared.ready.conversationId;
    expect(conversation).toMatch(agent === "pi" ? /^[a-f0-9-]{36}$/ : /^ses_[a-f0-9-]{36}$/);
    const fixture = join(home, "consume.mjs");
    await writeFile(
      fixture,
      `
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const agent=${JSON.stringify(agent)}, conversation=${JSON.stringify(conversation)};
if(agent==='pi') {
 const file=process.argv[process.argv.indexOf('--extension')+1];
 const extension=(await import(pathToFileURL(file))).default;
 const handlers=new Map(); let registered;
 extension({on(name,handler){const previous=handlers.get(name);handlers.set(name,async (...args)=>{await previous?.(...args);await handler(...args);});},
 registerMcpServer(name,config){registered={name,...config};}, unregisterMcpServer(){registered=undefined;}});
 const ctx={sessionManager:{getSessionId:()=>conversation},isIdle:()=>false};
 await handlers.get('session_start')({},ctx);
 assert.deepEqual(Object.keys(registered.toolExposure),['whoami','manual','handoff']);
 assert.deepEqual(registered.args,['--mcp']);
 assert.equal(registered.command,process.execPath);
 await handlers.get('agent_start')({},ctx);
 await handlers.get('agent_before_settle')({outcome:'completed'},ctx);
 await handlers.get('agent_settled')({aborted:false},ctx);
 console.log(JSON.stringify(registered));
 process.env.FOOM_REMOTE_TOKEN='f'.repeat(64);
 await handlers.get('before_agent_start')({},ctx);
 assert.equal(registered,undefined);
} else {
 const hooks=JSON.parse(readFileSync(process.env.OPENCODE_CONFIG,'utf8'));
 const module=(await import(pathToFileURL(hooks.plugins[0]+'/index.mjs'))).default;
 let finished; const done=new Promise(resolve=>finished=resolve);
 const dispose=module.setup({event:{async *subscribe(){
  yield {id:'first',type:'session.execution.started',data:{sessionID:conversation,prompt:'PRIVATE'}};
  yield {id:'second',type:'session.execution.succeeded',data:{sessionID:conversation}};
  finished();
 }}});
 await done; dispose();
 console.log(process.env.OPENCODE_CONFIG_CONTENT);
}
`,
    );
    const result = await promisify(execFile)(process.execPath, [fixture, ...prepared.spec.args], {
      cwd: home,
      env: prepared.spec.env,
      timeout: 10000,
      encoding: "utf8",
    });
    expect(signal.mock.calls.map(([value]) => value.action)).toEqual(
      ["ready", "working", "classify"].filter((value) => agent === "pi" || value !== "ready"),
    );
    expect(JSON.stringify(signal.mock.calls)).not.toContain("PRIVATE");
    expect(result.stdout).toContain("--mcp");
    const directory = prepared.endpoint.directory;
    prepared.endpoint.dispose();
    await expect(readFile(join(directory, "extension/launch.json"))).rejects.toThrow();
  },
);

test("the remote Pi ABI is locked to application-owned bytes", () => {
  expect(() => {
    assertRemotePiIntegrity(remotePiExtension());
  }).not.toThrow();
  expect(() => {
    assertRemotePiIntegrity(remotePiExtension() + " ");
  }).toThrow("integrity");
});

test.skipIf(process.platform === "win32")(
  "registered worktree launches require profile provenance before discovery and revalidate it at spawn",
  async () => {
    const { writeWorktreeProvenance, worktreeProvenancePath } = await import(
      "../../../../src/terminal-host/remote/worktree-provenance"
    );
    const repository = join(home, "repo");
    const worktree = join(home, ".foom-worktree-owned");
    await mkdir(repository, { mode: 0o700 });
    await mkdir(worktree, { mode: 0o700 });
    const profile = "a".repeat(32);
    const request = {
      ...spec,
      repository,
      worktree,
      checkoutIdentity: createHash("sha256").update("identity").digest("hex"),
    };
    const prepare = (owner = profile) =>
      prepareRemoteAgent(request, "/fixture/shell", home, () => {}, call, undefined, owner);
    await expect(prepare()).rejects.toMatchObject({ reason: "remote_worktree_unavailable" });
    expect(hostDiscovery).not.toHaveBeenCalled();
    await writeWorktreeProvenance(profile, repository, worktree, "git@fixture.test:team/repo.git");
    await expect(prepare("b".repeat(32))).rejects.toMatchObject({
      reason: "remote_worktree_unavailable",
    });
    const prepared = await prepare();
    endpoints.push(prepared.endpoint);
    await prepared.validate();
    await rm(worktreeProvenancePath(worktree));
    await expect(prepared.validate()).rejects.toMatchObject({
      reason: "remote_worktree_unavailable",
    });
  },
);
