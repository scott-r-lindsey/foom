// Synthetic real-CLI probe: temporary homes, loopback-only model replies, no provider calls.
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { claudeToolCall } from "./mcp-probe-model.mjs";
const execute = promisify(execFile);
async function phase(name) {
  if (process.env.FOOM_PROBE_STATUS)
    await writeFile(process.env.FOOM_PROBE_STATUS, JSON.stringify(name));
}
function terminateGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function run(command, args, options) {
  const pending = execute(command, args, {
    ...options,
    detached: true,
    timeout: 45000,
    maxBuffer: 1024 * 1024,
  });
  pending.child.stdin.end();
  try {
    return await pending;
  } finally {
    terminateGroup(pending.child.pid);
  }
}
if (process.platform !== "linux")
  throw new Error("This probe requires Linux and bwrap for isolated managed policy");

const scratch = await mkdtemp(join(tmpdir(), "foom-mcp-probe-"));
const bundle = join(scratch, "control.mjs");
await build({
  stdin: {
    contents:
      'export { PreviewBroker } from "./src/main/control/previews"; export { ControlMcp } from "./src/main/control/mcp"; export { ControlService } from "./src/main/control/service"; export { ControlHttp } from "./src/main/control/http"; export { Operations } from "./src/main/control/operations"; export { agentProvider } from "./src/main/agents/providers/registry";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundle,
});
const { PreviewBroker, ControlMcp, ControlService, ControlHttp, Operations, agentProvider } =
  await import(bundle);
const protocol = [];
const mcpDispatch = ControlMcp.prototype.dispatch;
ControlMcp.prototype.dispatch = function (actor, headers, input) {
  const result = mcpDispatch.call(this, actor, headers, input);
  protocol.push({ actor: actor.terminalId, method: input.method });
  return result;
};
await writeFile(join(scratch, "probe.html"), "<h1>Synthetic preview</h1>");
const previewIds = new Set();
const service = new ControlService(
  new Operations(
    async () => {},
    () => {},
  ),
  undefined,
  undefined,
  undefined,
  undefined,
  new PreviewBroker(
    {
      open: async (_actor, preview) => {
        previewIds.add(preview.previewId);
        return "sidebar";
      },
      close: async (id) => {
        previewIds.delete(id);
      },
      has: (id) => previewIds.has(id),
      visible: () => false,
    },
    async () => {},
    (actor) => service.assertActive(actor),
  ),
);
const http = await ControlHttp.listen(service);
const grant = service.prepare(scratch, scratch);
grant.bind("synthetic");
let calls = 0;
const observedMethods = new Set();
const dispatch = service.call.bind(service);
service.call = async (actor, input) => {
  calls++;
  const result = await dispatch(actor, input);
  if (actor.terminalId === "synthetic" && ["whoami", "open_preview"].includes(input.method))
    observedMethods.add(input.method);
  return result;
};
let requests = 0;
const observed = { existing: false };
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  requests++;
  if (body.tools?.some((t) => t.name?.startsWith("mcp__existing"))) observed.existing = true;
  if (process.env.FOOM_PROBE_DEBUG)
    console.log(
      "MODEL",
      req.url,
      JSON.stringify(body.tools?.filter((t) => !t.name || t.name.includes("foom"))),
    );
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  if (req.url?.includes("messages")) {
    const completed = observedMethods.has("whoami")
      ? observedMethods.has("open_preview")
        ? 2
        : 1
      : 0;
    const tool = claudeToolCall(body, completed);
    event("message_start", {
      message: {
        id: "msg_probe",
        type: "message",
        role: "assistant",
        content: [],
        model: "synthetic",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    if (tool) {
      event("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: tool.id,
          name: tool.name,
          input: {},
        },
      });
      event("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
      });
    } else {
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "Synthetic probe complete." },
      });
    }
    event("content_block_stop", { index: 0 });
    event("message_delta", {
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    event("message_stop", {});
  } else {
    const namespace = body.tools?.find(
      (t) => t.type === "namespace" && t.name.startsWith("mcp__foom_"),
    );
    const completed = observedMethods.has("whoami")
      ? observedMethods.has("open_preview")
        ? 2
        : 1
      : 0;
    const name = completed === 0 ? "whoami" : "open_preview";
    const tool =
      namespace?.tools.find((t) => t.name === name) ??
      body.tools?.find((t) => t.name?.endsWith(`__${name}`));
    const done = completed >= 2;
    const argumentsForTool = name === "whoami" ? {} : { path: "probe.html" };
    const output =
      tool && !done
        ? {
            type: "function_call",
            id: `fc_probe_${completed}`,
            call_id: `call_probe_${completed}`,
            ...(namespace ? { namespace: namespace.name } : {}),
            name: tool.name,
            arguments: JSON.stringify(argumentsForTool),
            status: "completed",
          }
        : {
            type: "message",
            id: "msg_probe",
            role: "assistant",
            content: [{ type: "output_text", text: "Synthetic probe complete.", annotations: [] }],
            status: "completed",
          };
    event("response.created", {
      response: { id: "resp_probe", object: "response", status: "in_progress", output: [] },
    });
    event("response.output_item.added", { output_index: 0, item: output });
    event("response.output_item.done", { output_index: 0, item: output });
    event("response.completed", {
      response: {
        id: "resp_probe",
        object: "response",
        status: "completed",
        output: [output],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
  }
  res.end();
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelUrl = `http://127.0.0.1:${model.address().port}`;
try {
  for (const agent of process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex"]) {
    const executable = process.env[`FOOM_${agent.toUpperCase()}_EXECUTABLE`] ?? agent;
    const limits = { timeout: 5000, maxBuffer: 256 * 1024 };
    const version = (await execute(executable, ["--version"], limits)).stdout.trim();
    const help = (await execute(executable, ["--help"], limits)).stdout;
    console.log(`Probing ${version}`);
    const home = join(scratch, agent);
    await mkdir(home);
    const provider = agentProvider(agent);
    const installation = provider.discover(executable, version, help);
    assert(provider.prepareLaunch, "Bundled provider must use the shared launch engine");
    const prepared = await provider.prepareLaunch(
      installation,
      { agent, repository: scratch, worktree: scratch, cols: 80, rows: 24 },
      [],
      { env: { FOOM_CONTROL_URL: http.endpoint }, bind: () => undefined, dispose: () => undefined },
      false,
      false,
    );
    assert(prepared.mcp && prepared.mcpArguments?.length, "Per-launch MCP unavailable");
    const attachment = { args: prepared.mcpArguments, dispose: prepared.dispose };
    const existingGrant = service.prepare(scratch, scratch);
    existingGrant.bind("existing");
    const existingUrl = http.endpoint.replace("/control/v1", "/mcp");
    const configPath = join(home, agent === "claude" ? ".claude.json" : "config.toml");
    const existingConfig =
      agent === "claude"
        ? JSON.stringify({
            mcpServers: {
              existing: {
                type: "http",
                url: existingUrl,
                headers: { Authorization: "Bearer ${EXISTING_TOKEN}" },
              },
            },
          })
        : `[mcp_servers.existing]\nurl=${JSON.stringify(existingUrl)}\nbearer_token_env_var="EXISTING_TOKEN"\n`;
    await writeFile(configPath, existingConfig);
    observed.existing = false;
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: home,
      CLAUDE_CONFIG_DIR: home,
      ...grant.env,
      EXISTING_TOKEN: existingGrant.env.FOOM_CONTROL_TOKEN,
      ANTHROPIC_BASE_URL: modelUrl,
      ANTHROPIC_API_KEY: "synthetic",
      OPENAI_API_KEY: "synthetic",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    };
    let args =
      agent === "claude"
        ? ["-p", "--permission-mode", "default", "--output-format", "json", ...prepared.args]
        : [
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--json",
            "-c",
            'model_provider="synthetic"',
            "-c",
            `model_providers.synthetic={name="synthetic",base_url="${modelUrl}/v1",wire_api="responses"}`,
            "-c",
            'model="synthetic"',
            ...attachment.args,
          ];
    args.push(
      "--",
      "Task from your Foom orchestrator (another agent, not the user):\n\nRun the Foom whoami tool, then open_preview with path probe.html.",
    );
    observedMethods.clear();
    const before = calls;
    protocol.length = 0;
    try {
      await phase("client execution");
      const result = await run(executable, args, { env, cwd: home });
      if (process.env.FOOM_PROBE_DEBUG) console.log(result.stdout, result.stderr);
      for (const method of ["initialize", "tools/list", "tools/call"]) {
        await phase(`authenticated ${method}`);
        assert(
          protocol.some((entry) => entry.actor === "synthetic" && entry.method === method),
          `${agent}: missing authenticated ${method}`,
        );
      }
      await phase("existing-server coexistence");
      assert(observed.existing, `${agent}: existing user server was not retained`);
      await phase("configuration preservation");
      if (agent === "codex") assert.equal(await readFile(configPath, "utf8"), existingConfig);
      else
        assert.deepEqual(
          JSON.parse(await readFile(configPath, "utf8")).mcpServers,
          JSON.parse(existingConfig).mcpServers,
        );
      await phase("authenticated tool call");
      assert(calls > before, `${agent}: no authenticated tool call (${requests} model requests)`);
      assert(observedMethods.has("whoami"), `${agent}: no authenticated identity call`);
      assert(previewIds.size > 0, `${agent}: no preview opened`);
      previewIds.clear();
      console.log(
        `${agent}: authenticated initialize/list/call and existing-server coexistence passed`,
      );
      // A mount namespace supplies synthetic administrator policy without editing /etc.
      if (process.platform !== "linux")
        throw new Error("Managed-policy probe currently requires Linux bwrap");
      const policy = join(home, "policy");
      await mkdir(policy);
      await writeFile(
        join(policy, agent === "claude" ? "managed-settings.json" : "requirements.toml"),
        agent === "claude"
          ? JSON.stringify({ allowedMcpServers: [], allowManagedMcpServersOnly: true })
          : "[mcp_servers]\n",
      );
      const command = process.env[`FOOM_${agent.toUpperCase()}_EXECUTABLE`] ?? agent;
      observedMethods.clear();
      const deniedBefore = calls;
      observed.existing = false;
      await phase("managed-policy execution");
      const denied = run(
        "bwrap",
        [
          "--ro-bind",
          "/",
          "/",
          "--bind",
          home,
          home,
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--tmpfs",
          "/etc",
          "--ro-bind",
          "/etc/passwd",
          "/etc/passwd",
          "--ro-bind",
          policy,
          agent === "claude" ? "/etc/claude-code" : "/etc/codex",
          "--",
          command,
          ...args,
        ],
        { env, cwd: home, timeout: 45000, maxBuffer: 1024 * 1024 },
      );
      const deniedResult = await denied;
      if (process.env.FOOM_PROBE_DEBUG) console.log(deniedResult.stdout, deniedResult.stderr);
      await phase("managed-policy refusal");
      assert.equal(calls, deniedBefore, `${agent}: managed refusal still allowed a call`);
      await phase("managed-policy existing-server refusal");
      assert.equal(
        observed.existing,
        false,
        `${agent}: managed policy did not filter existing server`,
      );
      console.log(`${agent}: managed-policy refusal passed`);
    } catch (error) {
      console.error(error.stdout, error.stderr);
      throw error;
    } finally {
      attachment.dispose();
      existingGrant.dispose();
    }
  }
} finally {
  grant.dispose();
  await http.close();
  await new Promise((resolve) => model.close(resolve));
  model.closeAllConnections();
  await rm(scratch, { recursive: true, force: true });
}
