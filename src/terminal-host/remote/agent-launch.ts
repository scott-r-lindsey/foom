import { remoteReviewSnapshot } from "./review-snapshot";
import { readWorktreeProvenance } from "./worktree-provenance";
import { eventModule } from "../../shared/agent-event-module";
import { remotePiExtension } from "./pi-extension";
import { LaunchFailure } from "../../shared/launch-failure";
import { matchesArguments } from "../../shared/agent-argument-matchers";
import { hostSocket, privateDirectory } from "./private-path";
import { createHash, randomUUID } from "node:crypto";
import { open, writeFile, mkdtemp } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { tomlContainer } from "../../shared/agent-manifest-container";
import { bundledAgentData } from "../../shared/bundled-agent-data";
import { parseAgentManifest } from "../../shared/agent-plugin-parser";
import {
  selected,
  discoveryFacts,
  expandV2,
  boundedArguments,
  collectMerge,
  bypassEnvironment,
} from "../../shared/agent-launch-values";
import type { RemoteAgentSpec, RemoteControlResult } from "../../shared/remote-agent";
import type { HookSignal } from "../../shared/hooks";
import type { TerminalSpec } from "../../shared/desktop";
import { record } from "../../shared/remote-agent-protocol";
import { AgentEndpoint } from "./agent-endpoint";
import { hostDiscovery, remoteCheckout, hostEnvironment, hostProbe } from "./agent-discovery";

async function remoteJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536) throw new Error("Invalid remote metadata");
    const bytes = Buffer.alloc(65537);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > 65536) throw new Error("Remote metadata too large");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)),
    ) as unknown;
  } finally {
    await file.close();
  }
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
const mcpSentinel = "http://127.0.0.1:1/mcp";
/** Convert only the selected per-launch HTTP attachment, never user/global MCP data. */
export function remoteMcpArgument(argument: string, helper: string): string {
  const equals = argument.indexOf("=");
  if (equals < 1 || !argument.includes(mcpSentinel)) return argument;
  const table: unknown = tomlContainer(argument.slice(equals + 1), "remote MCP");
  if (
    !record(table) ||
    table["url"] !== mcpSentinel ||
    table["bearer_token_env_var"] !== "FOOM_CONTROL_TOKEN"
  )
    throw new Error("Unsupported remote MCP attachment");
  return `${argument.slice(0, equals + 1)}{command=${JSON.stringify(helper)},args=["--mcp"],env_vars=["FOOM_REMOTE_SOCKET","FOOM_REMOTE_TOKEN"]}`;
}
export function remoteMcpFile(content: string, helper: string, name: string): string {
  const value: unknown = JSON.parse(content);
  if (record(value) && record(value["mcp"]) && record(value["mcp"]["servers"])) {
    const servers = value["mcp"]["servers"];
    const server = servers[name];
    if (!record(server) || server["url"] !== mcpSentinel)
      throw new Error("Invalid remote MCP attachment");
    servers[name] = { type: "local", command: [helper, "--mcp"], codemode: false };
    return JSON.stringify(value);
  }
  if (!record(value) || !record(value["mcpServers"]))
    throw new Error("Unsupported remote MCP file");
  const server = value["mcpServers"][name];
  if (!record(server) || server["url"] !== mcpSentinel)
    throw new Error("Invalid remote MCP attachment");
  value["mcpServers"][name] = {
    command: helper,
    args: ["--mcp"],
    env: {
      FOOM_REMOTE_SOCKET: "${FOOM_REMOTE_SOCKET}",
      FOOM_REMOTE_TOKEN: "${FOOM_REMOTE_TOKEN}",
    },
  };
  return JSON.stringify(value);
}
export async function prepareRemoteAgent(
  request: RemoteAgentSpec,
  shell: string,
  home: string,
  signal: (signal: HookSignal) => void,
  call: (method: string, params: unknown) => Promise<RemoteControlResult>,
  cancellation?: AbortSignal,
  profile?: string,
) {
  // Build inputs are immutable application bytes; peer-supplied manifests are not accepted.
  const model = bundledAgentData
    .map((data) => parseAgentManifest(JSON.stringify(data), "bundled").model)
    .find((model) => model.id === request.agent);
  if (!model) throw new LaunchFailure("remote_agent_unsupported");
  const checkout = () =>
    remoteCheckout(request.repository, request.worktree, hostEnvironment(), cancellation).catch(
      () => {
        throw new LaunchFailure("remote_worktree_unavailable");
      },
    );
  const validateOwner = async () => {
    if (!request.checkoutIdentity || profile === undefined) return;
    const owner = await readWorktreeProvenance(request.worktree);
    if (!owner || owner.profile !== profile || owner.repository !== request.repository)
      throw new LaunchFailure("remote_worktree_unavailable");
  };
  await validateOwner();
  const identity = await checkout();
  if (
    request.checkoutIdentity !== undefined &&
    createHash("sha256").update(identity).digest("hex") !== request.checkoutIdentity
  )
    throw new LaunchFailure("remote_worktree_unavailable");
  const validateReview = async (env: NodeJS.ProcessEnv) => {
    if (!request.reviewSnapshot) return;
    const snapshot = await remoteReviewSnapshot(
      request.repository,
      request.worktree,
      createHash("sha256").update(identity).digest("hex"),
      { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null" },
      cancellation,
    );
    if (
      snapshot.head !== request.reviewSnapshot.head ||
      snapshot.digest !== request.reviewSnapshot.digest
    )
      throw new LaunchFailure("remote_worktree_unavailable");
  };
  const found = await hostDiscovery(model, shell, home, cancellation);
  if (bypassEnvironment(model, found.env, false).length)
    throw new Error("Remote child environment bypass is unavailable");
  const endpoint = new AgentEndpoint(model.id, signal, call, true);
  try {
    await endpoint.listen();
    let setupState = "unavailable";
    if (model.setup) {
      // Read-only remote CLI-owned metadata. Installation remains an explicit user action.
      try {
        await hostProbe(
          found.command,
          ["plugin", "list", "--json"],
          home,
          found.env,
          false,
          5000,
          cancellation,
        );
        const metadata = await remoteJson(join(home, ".gemini/config/plugins/foom/plugin.json"));
        const config = await remoteJson(join(home, ".gemini/config/config.json")).catch(
          () => undefined,
        );
        const plugin =
          record(config) && record(config["plugins"]) ? config["plugins"]["foom"] : undefined;
        const enabled = record(plugin)
          ? plugin["enabled"] === true
          : record(metadata) && metadata["disabled"] !== true;
        if (
          record(metadata) &&
          metadata["name"] === "foom" &&
          typeof metadata["foomObserverVersion"] === "number" &&
          metadata["foomObserverVersion"] >= 4 &&
          enabled
        )
          setupState = "installed";
      } catch {
        /* Missing/old/disabled plugins retain screen evaluation. */
      }
    }
    const facts = {
      ...discoveryFacts(model, found.version, found.help, {
        control: true,
        hooksEnabled: request.hooks,
        hasPrompt: request.prompt !== undefined,
        configGreeting: false,
        resume: request.conversationId !== undefined,
        healthTrusted: false,
        setupState,
      }),
    };
    // The installed plugin bridge targets local loopback HTTP, not the private remote socket.
    facts["pluginMcp"] = false;
    const conversation =
      request.conversationId ??
      (model.conversation.newId
        ? (model.conversation.newId.prefix ?? "") + randomUUID()
        : undefined);
    const mcp = Boolean(model.launch.mcp && selected(model.launch.mcp.when, facts));
    const values: Record<string, string | string[] | number> = {
      hookDir: endpoint.directory,
      mcpName: `foom_${randomUUID().replaceAll("-", "")}`,
      mcpUrl: mcpSentinel,
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      ...(!request.conversationId && conversation ? { newId: conversation } : {}),
    };
    if (conversation) endpoint.state.conversation = conversation;
    values["toolRules"] = JSON.stringify(
      ["whoami", "manual", "handoff"].map((name) => ({
        action: `${String(values["mcpName"])}_${name}`,
        resource: "*",
        effect: "allow",
      })),
    );
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(found.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    Object.assign(env, endpoint.env());
    const bin = endpoint.folder("bin");
    await writeFile(join(bin, "foom"), `#!/bin/sh\nexec ${quote(process.execPath)} --cli "$@"\n`, {
      mode: 0o700,
      flag: "wx",
    });
    env["PATH"] = `${bin}:${env["PATH"] ?? ""}`;
    for (const channel of model.hooks?.channels ?? []) {
      const attached = request.hooks && selected(channel.when, facts);
      facts[`channelAttached:${channel.id}`] = attached;
      if (!attached) continue;
      endpoint.channels.set(channel.id, channel);
      const options = channel.observer;
      if (options.transport === "event-module") {
        const root = endpoint.folder(channel.id);
        await writeFile(join(root, "index.mjs"), eventModule(channel, true), {
          mode: 0o600,
          flag: "wx",
        });
        values[`observerModule:${channel.id}`] = root;
        continue;
      }
      const base = [
        process.execPath,
        "--observe",
        channel.id,
        options.transport,
        options.response,
        options.sequence ? "ordered" : "unordered",
      ];
      const add = (event?: string) => {
        const args = [...base, ...options.commandArguments, ...(event ? [event] : [])];
        const suffix = event ? `.${event}` : "";
        values[`observerCommand:${channel.id}${suffix}`] = args.map(quote).join(" ");
        values[`observerArgv:${channel.id}${suffix}`] = args;
      };
      add();
      for (const event of new Set(channel.mapping.cases.map((entry) => entry.event))) add(event);
      values[`observerVersion:${channel.id}`] =
        typeof options.version === "number" ? options.version : options.version.posix;
      if (options.sequence) {
        const order = join(endpoint.directory, `${channel.id}.order`);
        await writeFile(order, "0", { mode: 0o600, flag: "wx" });
        env[`FOOM_ORDER_${channel.id.replaceAll("-", "_")}`] = order;
        if (options.protocol === "ordered-v2") env["FOOM_HOOK_ORDER"] = order;
      }
    }
    const extension = model.launch.extension;
    const attachExtension = Boolean(
      extension &&
        selected(extension.when, facts) &&
        (mcp || endpoint.channels.has(extension.channel)),
    );
    if (attachExtension && extension) {
      const root = endpoint.folder("extension");
      const path = join(root, "pi-remote-v1.mjs");
      await writeFile(path, remotePiExtension(), { mode: 0o600, flag: "wx" });
      await writeFile(
        join(root, "launch.json"),
        JSON.stringify({
          ...(endpoint.channels.has(extension.channel) ? { channel: extension.channel } : {}),
          ...(mcp ? { mcp: { name: values["mcpName"] } } : {}),
        }),
        { mode: 0o600, flag: "wx" },
      );
      values["extensionFile"] = path;
    }
    endpoint.state.launchFacts = facts;
    const prompts = request.prompt
      ? [
          "Task from your local Foom orchestrator (another agent, not the user). Before stopping when finished, blocked or CI fails, report with handoff({status: done|blocked|failed, summary, idempotencyKey}) or foom handoff --status done|blocked|failed --summary-file FILE|- [--link HTTPS_URL] --idempotency-key KEY. Handoffs are pull-only; they never type into a terminal.\n\n" +
            request.prompt,
        ]
      : [];
    let defaults = [...request.defaults];
    const guidance = model.launch.guidance && selected(model.launch.guidance.when, facts);
    if (guidance && model.launch.guidance?.merge) {
      const collected = collectMerge(defaults, model.launch.guidance.merge, model.launch, false);
      defaults = collected.args;
      prompts.unshift(...collected.values);
    }
    if (guidance)
      prompts.push(
        "Use foom whoami --json for your launch alias and capabilities. Remote phase 2 exposes handoff, manual and identity only; filesystem preview and fleet/repository tools are unavailable to remote children.",
      );
    if (prompts.length) {
      if (
        !model.launch.prompt ||
        (model.launch.prompt.requires && !facts[model.launch.prompt.requires])
      )
        throw new Error("Remote agent cannot take an initial prompt");
      values["prompt"] = prompts.join("\n\n");
    }
    for (const file of model.files.filter(
      (file) => file.scope === "launch" && selected(file.when, facts),
    )) {
      if (!mcp && model.launch.mcp?.arguments.some((arg) => arg.includes(`{file:${file.name}}`)))
        continue;
      const target = join(endpoint.directory, file.name);
      values[`file:${file.name}`] = target;
      values[`hookFile:${file.name}`] = target;
      let content = expandV2(
        file.content.replaceAll("{toolRules:json}", values["toolRules"]),
        values,
      );
      if (content.includes(mcpSentinel))
        content = remoteMcpFile(content, process.execPath, String(values["mcpName"]));
      values[`fileContent:${file.name}`] = content;
      await writeFile(target, content, { mode: 0o600, flag: "wx" });
    }
    const args: string[] = [];
    const expand = (templates: readonly string[]) => templates.map((arg) => expandV2(arg, values));
    for (const stage of model.launch.order) {
      if (stage === "defaults") args.push(...defaults);
      else if (stage === "resume" && request.conversationId) {
        if (!model.launch.resume || !selected(model.launch.resume.when, facts))
          throw new Error("Remote resume unavailable");
        args.push(...expand(model.launch.resume.arguments));
      } else if (stage === "arguments") {
        if (!request.conversationId && conversation && model.conversation.newId)
          args.push(...expand(model.conversation.newId.arguments));
        if (model.launch.arguments && selected(model.launch.arguments.when, facts))
          args.push(...expand(model.launch.arguments.arguments));
      } else if (
        stage === "display" &&
        model.launch.display &&
        selected(model.launch.display.when, facts)
      )
        args.push(...expand(model.launch.display.arguments));
      else if (stage === "mcp") {
        if (attachExtension && extension) args.push(...expand(extension.arguments));
        if (mcp && model.launch.mcp)
          args.push(
            ...expand(model.launch.mcp.arguments).map((arg) =>
              remoteMcpArgument(arg, process.execPath),
            ),
          );
      } else if (stage === "hooks")
        for (const channel of endpoint.channels.values()) args.push(...expand(channel.arguments));
      else if (stage === "tools" && mcp && model.launch.toolPermissions) {
        const permissions = model.launch.toolPermissions;
        const grants = ["whoami", "manual", "handoff"]
          .filter((name) => permissions.names.includes(name))
          .map((name) =>
            permissions.format === "mcp-double-underscore"
              ? `mcp__${String(values["mcpName"])}__${name}`
              : `${String(values["mcpName"])}(${name})`,
          );
        if (permissions.merge && grants.length) args.push(permissions.merge.output, ...grants);
        else
          for (const tool of grants)
            args.push(...permissions.arguments.map((arg) => expandV2(arg, { ...values, tool })));
      } else if (stage === "prompt" && prompts.length && model.launch.prompt)
        args.push(
          ...expand(
            model.launch.guidance?.merge && guidance
              ? [model.launch.guidance.merge.output, "{prompt}"]
              : model.launch.prompt.arguments,
          ),
        );
    }
    if (matchesArguments(model.bypassArguments, args))
      throw new Error("Remote child bypass is unavailable");
    for (const entry of model.launch.environment ?? [])
      if (selected(entry.when, facts)) env[entry.name] = expandV2(entry.value, values);
    if ((await checkout()) !== identity) throw new LaunchFailure("remote_worktree_unavailable");
    await validateReview(found.env);
    cancellation?.throwIfAborted();
    const spec: Omit<TerminalSpec, "cols" | "rows"> = {
      command: found.command,
      args: boundedArguments(args),
      cwd: request.worktree,
      env,
      replaceEnvironment: true,
    };
    return {
      validate: async () => {
        await validateReview(found.env);
        await validateOwner();
        if ((await checkout()) !== identity) throw new LaunchFailure("remote_worktree_unavailable");
      },
      spec,
      endpoint,
      ready: {
        channels: [...endpoint.channels.keys()],
        hooks: endpoint.channels.size > 0,
        mcp,
        ...(conversation ? { conversationId: conversation } : {}),
      },
    };
  } catch (error) {
    endpoint.dispose();
    throw error;
  }
}

/** Explicit remote-shell command: stage reviewed assets, leaving installation to the user. */
export async function stageRemotePlugin(agent: string, home: string): Promise<string> {
  const model = bundledAgentData
    .map((data) => parseAgentManifest(JSON.stringify(data), "bundled").model)
    .find((model) => model.id === agent);
  if (!model?.setup || !model.files.some((file) => file.scope === "plugin"))
    throw new Error("No bundled remote plugin");
  const root = dirname(hostSocket(home));
  const directory = await mkdtemp(join(root, "plugin-"));
  privateDirectory(directory);
  const values: Record<string, string | number> = {};
  for (const channel of model.hooks?.channels ?? []) {
    values[`observerVersion:${channel.id}`] =
      typeof channel.observer.version === "number"
        ? channel.observer.version
        : channel.observer.version.posix;
    for (const event of new Set(channel.mapping.cases.map((entry) => entry.event)))
      values[`observerCommand:${channel.id}.${event}`] = [
        process.execPath,
        "--observe",
        channel.id,
        "stdin",
        "empty-json-first",
        "ordered",
        event,
      ]
        .map(quote)
        .join(" ");
  }
  for (const file of model.files.filter((file) => file.scope === "plugin"))
    await writeFile(join(directory, file.name), expandV2(file.content, values), {
      mode: 0o600,
      flag: "wx",
    });
  return directory;
}
