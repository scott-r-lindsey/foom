import { validateConfig } from "../../../src/cli/config";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../../fixtures/agent-plugins-v2/external.json";
import { execute } from "../../../src/cli/execute";
import { hookCommand } from "../../../src/cli/hook";
import { HookReceiver } from "../../../src/main/agents/hook-receiver";
import { prepareV2Hooks } from "../../../src/main/agents/providers/v2-hook-launch";
import { observerAssets } from "../../../src/main/agents/providers/v2-observers";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";
import type { HookSignal } from "../../../src/shared/hooks";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
function input(value: string | Buffer = '{"conversationId":"conversation-1","id":"event-1"}') {
  return Readable.from([value]);
}
async function setup() {
  const model = parseAgentManifest(JSON.stringify(fixture)).model;
  const channel = model.hooks?.channels[0];
  if (!channel) throw Error("Missing channel");
  const signals: HookSignal[] = [];
  const receiver = await HookReceiver.listen((signal) => signals.push(signal));
  cleanup.push(() => receiver.close());
  const launch = receiver.register("terminal-1", model.id, {
    channels: new Map([[channel.id, channel]]),
    state: {},
  });
  const env = { ...launch.env, FOOM_HOOK_PROTOCOL: "1", FOOM_HOOK_CHANNELS: '["lifecycle"]' };
  return { model, channel, signals, receiver, launch, env };
}
it("is immediately silent outside Foom, including with inherited control credentials", async () => {
  const read = vi.fn();
  const out = vi.fn();
  const unread = {
    [Symbol.asyncIterator]() {
      read();
      return input()[Symbol.asyncIterator]();
    },
  };
  expect(
    await execute(
      ["hook", "Working"],
      "1",
      { out, error: out, input: unread },
      { FOOM_CONTROL_TOKEN: "foreign" },
      "foom",
    ),
  ).toBe(0);
  expect(read).not.toHaveBeenCalled();
  expect(out).not.toHaveBeenCalled();
});
it("uses the existing reducer for dedupe, validation, first-event pinning and attention actions", async () => {
  const { env, signals } = await setup();
  const send = (event: string, value?: string) => hookCommand(["hook", event], input(value), env);
  expect(await send("Unknown", '{"conversationId":"unknown","id":"event-1"}')).toBe(0);
  expect(await send("Working")).toBe(0);
  expect(await send("Working")).toBe(0);
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({
    terminalId: "terminal-1",
    conversationId: "conversation-1",
    action: "working",
  });
  expect(
    await send(
      "Permission",
      '{"conversationId":"conversation-1","id":"event-2","FOOM_TOKEN":"ignored"}',
    ),
  ).toBe(0);
  expect(signals.at(-1)?.action).toBe("needs_input");
  expect(await send("Stop", '{"conversationId":"conversation-1","id":"event-3"}')).toBe(0);
  expect(signals.at(-1)?.action).toBe("classify");
  expect(await send("Stop", '{"conversationId":"other","id":"event-4"}')).toBe(1);
  expect(await send("Stop", '{"conversationId":"bad/id","id":"event-5"}')).toBe(1);
});
it("rejects stale, foreign and mixed launch credentials without delivering to another terminal", async () => {
  const { env, receiver, launch, signals, channel } = await setup();
  const other = receiver.register("terminal-2", fixture.id, {
    channels: new Map([[channel.id, channel]]),
    state: {},
  });
  for (const credentials of [
    { FOOM_TOKEN: "a".repeat(64) },
    { FOOM_SESSION: other.env.FOOM_SESSION },
    { FOOM_TOKEN: other.env.FOOM_TOKEN },
  ]) {
    expect(await hookCommand(["hook", "Working"], input(), { ...env, ...credentials })).toBe(1);
  }
  launch.revoke();
  expect(await hookCommand(["hook", "Working"], input(), env)).toBe(1);
  expect(signals).toEqual([]);
});
it("rejects invalid commands, environments and bounded input silently before delivery", async () => {
  const { env, signals } = await setup();
  for (const changes of [
    { FOOM_HOOK_PROTOCOL: "2" },
    { FOOM_HOOK_CHANNELS: "{" },
    { FOOM_HOOK_CHANNELS: "{}" },
    { FOOM_HOOK_CHANNELS: "[1]" },
    { FOOM_HOOK_CHANNELS: '["bad/id"]' },
    { FOOM_HOOK_CHANNELS: "[]" },
    { FOOM_TOKEN: "bad" },
    { FOOM_SESSION: "bad" },
  ]) {
    expect(await hookCommand(["hook", "Working"], input(), { ...env, ...changes })).toBe(2);
  }
  for (const url of [
    "https://127.0.0.1:80/hooks",
    "http://localhost:80/hooks",
    "http://127.0.0.1/hooks",
    "http://127.0.0.1:123/hooks?x",
    "http://127.0.0.1:123/hooks#x",
    "http://u:p@127.0.0.1:123/hooks",
    "http://127.0.0.1:123/other",
    "bad",
  ]) {
    expect(await hookCommand(["hook", "Working"], input(), { ...env, FOOM_HOOK_URL: url })).toBe(2);
  }
  for (const args of [
    ["hook"],
    ["hook", "bad\r\nheader"],
    ["hook", "Working", "--json"],
    ["hook", "Working", "--channel", "unknown"],
  ]) {
    expect(await hookCommand(args, input(), env)).toBe(2);
  }
  for (const data of ["{", " ".repeat(65537), Buffer.from([0xff])])
    expect(await hookCommand(["hook", "Working"], input(data), env)).toBe(2);
  expect(signals).toEqual([]);
  expect(
    await hookCommand(["hook", "Working", "--channel", "lifecycle"], input(), {
      ...env,
      FOOM_HOOK_CHANNELS: '["lifecycle","other"]',
    }),
  ).toBe(0);
});
it("caps HTTP delivery time and tolerates an unavailable receiver", async () => {
  const { env, receiver } = await setup();
  await receiver.close();
  expect(await hookCommand(["hook", "Working"], input(), env)).toBe(1);
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing address");
  expect(
    await hookCommand(["hook", "Working"], input(), {
      ...env,
      FOOM_HOOK_URL: `http://127.0.0.1:${String(address.port)}/hooks`,
    }),
  ).toBe(1);
});
it("external attachment generates no files, counters, commands or interpreter probes on either platform", async () => {
  const { model, receiver, channel } = await setup();
  for (const windows of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "foom-external-test-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const probe = vi.fn();
    const hooks = await prepareV2Hooks(receiver, model, () => {}, windows, root, root, probe);
    cleanup.push(() => {
      hooks.dispose();
    });
    expect(observerAssets(channel, windows)).toEqual({});
    expect(probe).not.toHaveBeenCalled();
    expect(hooks.env["FOOM_HOOK_PROTOCOL"]).toBe("1");
    expect(hooks.env["FOOM_HOOK_CHANNELS"]).toBe("[]");
    hooks.v2?.channels.set(channel.id, channel);
    expect(hooks.env["FOOM_HOOK_CHANNELS"]).toBe('["lifecycle"]');
    hooks.v2?.channels.set("internal", {
      ...channel,
      id: "internal",
      observer: { ...channel.observer, transport: "stdin" },
    });
    expect(hooks.env["FOOM_HOOK_CHANNELS"]).toBe('["lifecycle"]');
    expect(hooks.v2?.values).not.toHaveProperty("observerCommand:lifecycle");
    const files = await readdir(root, { recursive: true, withFileTypes: true });
    expect(files.every((entry) => entry.isDirectory())).toBe(true);
  }
  const changed = structuredClone(fixture);
  if (changed.hooks.channels[0]) Reflect.set(changed.hooks.channels[0], "arguments", ["--hook"]);
  expect(() => parseAgentManifest(JSON.stringify(changed))).toThrow();
  expect(() =>
    parseAgentManifest(
      JSON.stringify({
        ...fixture,
        hooks: {
          channels: fixture.hooks.channels.map((channel) => ({
            ...channel,
            observer: { transport: "external", sequence: true },
          })),
        },
      }),
    ),
  ).toThrow();
});

it("offline config validation accepts external channels and rejects observer options and attachment arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-external-config-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "foom-test-agent.json");
  await writeFile(file, JSON.stringify(fixture));
  expect(await validateConfig(file)).toMatchObject({ code: 0, problems: [] });
  const changed = structuredClone(fixture);
  if (!changed.hooks.channels[0]) throw Error("Missing channel");
  Reflect.set(changed.hooks.channels[0], "arguments", ["--hook"]);
  await writeFile(file, JSON.stringify(changed));
  expect(await validateConfig(file)).toMatchObject({ code: 1 });
});

it("silently consumes an interrupted error response", async () => {
  const { env } = await setup();
  let interrupted: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    interrupted = resolve;
  });
  const server = createServer((_request, response) => {
    response.writeHead(400, { "Content-Length": 100 });
    response.write("x");
    // Permit headers to arrive, then exercise the response stream's failure path.
    setTimeout(() => {
      response.destroy();
      interrupted?.();
    }, 10);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing address");
  const output = vi.fn();
  expect(
    await execute(
      ["hook", "Working"],
      "1",
      { out: output, error: output, input: input() },
      { ...env, FOOM_HOOK_URL: `http://127.0.0.1:${String(address.port)}/hooks` },
      "foom",
    ),
  ).toBe(1);
  await closed;
  expect(output).not.toHaveBeenCalled();
});
