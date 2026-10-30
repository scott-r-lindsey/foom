import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { eventModule } from "../../../../src/shared/agent-event-module";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import type { HookSignal } from "../../../../src/shared/hooks";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it("generated event modules bypass proxies, authenticate only loopback, reduce fields and stop on cleanup", async () => {
  const channel = structuredClone(agentProvider("opencode").model.hooks?.channels[0]);
  if (!channel) throw Error("Missing channel");
  channel.mapping.dedupe = { source: "payload", path: ["id"] };
  const first = channel.mapping.cases[0];
  if (!first) throw Error("Missing case");
  first.when = {
    all: [{ field: { source: "payload", path: ["data", "ok"] }, op: "eq", value: true }],
    any: [
      { field: "hooksEnabled", op: "eq", value: true },
      { field: { source: "header", path: ["ignored"] }, op: "absent", value: undefined },
    ],
  };
  first.require = [
    { field: { source: "payload", path: ["data", "ok"] }, type: "boolean", values: undefined },
  ];
  first.facts = [
    {
      name: "fullyIdle",
      field: { source: "payload", path: ["data", "fullyIdle"] },
      aliases: undefined,
    },
  ];
  const root = await mkdtemp(join(tmpdir(), "foom-event-module-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const signals: HookSignal[] = [];
  const receiver = await HookReceiver.listen((signal) => {
    signals.push(signal);
  });
  cleanup.push(() => receiver.close());
  const launch = receiver.register("terminal", "opencode", {
    channels: new Map([[channel.id, channel]]),
    state: { conversation: "ses_fixture", launchFacts: { hooksEnabled: true } },
  });
  cleanup.push(() => {
    launch.revoke();
  });
  const file = join(root, "observer.mjs");
  await writeFile(file, eventModule(channel));
  const driver = join(root, "driver.mjs");
  await writeFile(
    driver,
    `import plugin from ${JSON.stringify(pathToFileURL(file).href)};
const env=JSON.parse(process.argv[2]);Object.assign(process.env,env);
const events=JSON.parse(process.argv[3]);
const stop=plugin.setup({event:{async *subscribe({signal}){for(const event of events) {if(signal.aborted)return;yield event;}}}});
process.on('beforeExit',()=>stop());`,
  );
  const execute = async (env: Record<string, string>, events: unknown[]) =>
    promisify(execFile)(process.execPath, [driver, JSON.stringify(env), JSON.stringify(events)], {
      env: { HTTP_PROXY: "http://127.0.0.1:9", NODE_USE_ENV_PROXY: "1", NO_PROXY: "" },
      timeout: 5000,
    });
  const event = {
    id: "event1",
    type: "session.execution.started",
    data: { sessionID: "ses_fixture", ok: true, fullyIdle: false, transcript: "DO_NOT_FORWARD" },
  };
  const env = { ...launch.env, FOOM_HOOK_PROTOCOL: "1" };
  await execute(env, [
    null,
    { type: "unknown" },
    event,
    { ...event, data: { ...event.data, sessionID: "ses_foreign" } },
    { ...event, data: { ...event.data, ok: "x".repeat(4097) } },
    { ...event, data: { ...event.data, ok: { nested: "text" } } },
  ]);
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({
    action: "working",
    conversationId: "ses_fixture",
    fullyIdle: false,
  });
  for (const malformed of [
    null,
    { nested: "ses_fixture" },
    ["ses_fixture"],
    "s".repeat(201),
    "s".repeat(4097),
    "ses_conflicting",
  ]) {
    await execute(env, [
      {
        id: "evt_malformed",
        type: "form.created",
        data: { sessionID: malformed, form: { sessionID: "ses_fixture" } },
      },
      {
        id: "evt_malformed_reverse",
        type: "form.created",
        data: { sessionID: "ses_fixture", form: { sessionID: malformed } },
      },
    ]);
  }
  expect(signals).toHaveLength(1);
  await execute(env, [
    {
      id: "evt_malformed",
      type: "form.created",
      data: { sessionID: "ses_fixture", form: { sessionID: "ses_fixture" } },
    },
  ]);
  expect(signals).toHaveLength(2);
  expect(signals[1]).toMatchObject({ action: "needs_input", conversationId: "ses_fixture" });
  for (const overrides of [
    { FOOM_HOOK_PROTOCOL: "2" },
    { FOOM_TOKEN: "" },
    { FOOM_TOKEN: "bad" },
    { FOOM_SESSION: "bad" },
    { FOOM_HOOK_URL: "not a URL" },
    { FOOM_HOOK_URL: "http://example.com:123/hooks" },
    { FOOM_HOOK_URL: "http://127.0.0.1:1234/wrong" },
    { FOOM_HOOK_URL: "http://127.0.0.1:1234/hooks?token=bad" },
  ])
    await execute({ ...env, ...overrides }, [event]);
  expect(signals).toHaveLength(2);
  launch.revoke();
  await execute(env, [{ ...event, id: "revoked" }]);
  expect(signals).toHaveLength(2);
  // A minimal module remains inert without launch credentials, even with no optional selectors.
  channel.mapping.dedupe = undefined;
  channel.mapping.sessionAliases = undefined;
  for (const entry of channel.mapping.cases) {
    entry.when = undefined;
    entry.require = [];
    entry.facts = [];
  }
  await writeFile(file, eventModule(channel));
  await execute({}, [event]);
  expect(signals).toHaveLength(2);
});
