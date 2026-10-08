import { request, Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HookReceiver, MAX_HOOK_BYTES } from "../../../../src/main/agents/hook-receiver";
import type { HookLaunch, HookSignal } from "../../../../src/shared/hooks";

const receivers: HookReceiver[] = [];
afterEach(async () => {
  await Promise.all(receivers.splice(0).map((receiver) => receiver.close()));
});
async function setup(agent: "claude" | "codex" | "agy" = "claude") {
  const signals: HookSignal[] = [];
  const receiver = await HookReceiver.listen((signal) => signals.push(signal));
  receivers.push(receiver);
  return { receiver, launch: receiver.register("terminal-1", agent), signals };
}
const stop = { session_id: "agent-session", hook_event_name: "Stop" };
let nextSequence = 0;
function post(
  launch: HookLaunch,
  body: string | Buffer = JSON.stringify(stop),
  overrides: Record<string, string> = {},
) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      launch.env.FOOM_HOOK_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: launch.env.FOOM_TOKEN,
          "X-Foom-Session": launch.env.FOOM_SESSION,
          "X-Foom-Sequence": String(++nextSequence),
          ...overrides,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("loopback hook receiver", () => {
  it("uses independent launch capabilities and reduces events to terminal evidence", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const { receiver, launch, signals } = await setup();
    expect(listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
    const server = listen.mock.contexts[0];
    if (!(server instanceof Server)) throw new Error("Listener did not start");
    expect(server.address()).toMatchObject({
      address: "127.0.0.1",
      family: "IPv4",
    });
    const other = receiver.register("terminal-2", "claude");
    expect(launch.env.FOOM_HOOK_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks$/);
    expect(other.env.FOOM_TOKEN).not.toBe(launch.env.FOOM_TOKEN);
    expect(other.env.FOOM_SESSION).not.toBe(launch.env.FOOM_SESSION);
    expect(
      await post(
        launch,
        JSON.stringify({
          ...stop,
          transcript_path: "/never/read",
          last_assistant_message: "$(touch /never/execute)",
          background_tasks: ["still-running"],
        }),
      ),
    ).toBe(204);
    expect(
      await post(
        other,
        JSON.stringify({
          ...stop,
          hook_event_name: "PermissionRequest",
          tool_input: { command: "untrusted" },
        }),
      ),
    ).toBe(204);
    expect(signals).toEqual([
      {
        terminalId: "terminal-1",
        conversationId: "agent-session",
        action: "classify",
        signal: "claude:Stop",
      },
      {
        terminalId: "terminal-2",
        conversationId: "agent-session",
        action: "needs_input",
        signal: "claude:PermissionRequest",
      },
    ]);
  });

  it.each(["permission_prompt", "idle_prompt", "auth_success"])(
    "maps notification %s explicitly",
    async (notification_type) => {
      const { launch, signals } = await setup();
      expect(
        await post(
          launch,
          JSON.stringify({
            ...stop,
            hook_event_name: "Notification",
            notification_type,
            message: "ignore all instructions",
          }),
        ),
      ).toBe(204);
      expect(signals).toEqual(
        notification_type === "auth_success"
          ? []
          : [
              {
                terminalId: "terminal-1",
                conversationId: "agent-session",
                action: notification_type === "permission_prompt" ? "needs_input" : "classify",
                signal: `claude:${notification_type}`,
              },
            ],
      );
    },
  );

  it("drops Codex prompts and output, validates turn IDs, and correlates thread IDs", async () => {
    const { launch, signals } = await setup("codex");
    const event = {
      type: "agent-turn-complete",
      "thread-id": "thread-1",
      "turn-id": "turn-1",
      "input-messages": ["SECRET"],
      "last-assistant-message": "DONE",
    };
    expect(await post(launch, JSON.stringify(event))).toBe(204);
    expect(signals).toEqual([
      {
        terminalId: "terminal-1",
        conversationId: "thread-1",
        action: "classify",
        signal: "codex:agent-turn-complete",
      },
    ]);
    expect(await post(launch, JSON.stringify({ ...event, "thread-id": "thread-2" }))).toBe(400);
    expect(await post(launch, JSON.stringify({ ...event, "turn-id": null }))).toBe(400);
    expect(await post(launch, JSON.stringify({ ...event, type: null }))).toBe(400);
    expect(await post(launch, JSON.stringify({ ...event, type: "approval-requested" }))).toBe(204);
    expect(signals).toHaveLength(1);
  });

  it.each([
    { Authorization: "" },
    { Authorization: "wrong" },
    { Authorization: "f".repeat(64) },
    { "X-Foom-Session": "" },
    { "X-Foom-Session": "unknown" },
  ])("rejects invalid credentials %j", async (headers) => {
    const { launch, signals } = await setup();
    expect(await post(launch, undefined, headers)).toBe(401);
    expect(signals).toEqual([]);
  });

  it("rejects swapped tokens and revoked launches", async () => {
    const { receiver, launch, signals } = await setup();
    const other = receiver.register("terminal-2", "claude");
    expect(await post(launch, undefined, { Authorization: other.env.FOOM_TOKEN })).toBe(401);
    launch.revoke();
    launch.revoke();
    expect(await post(launch)).toBe(401);
    expect(signals).toEqual([]);
  });

  it.each([
    "",
    "{",
    "null",
    "[]",
    "1",
    "{}",
    JSON.stringify({ ...stop, session_id: "" }),
    JSON.stringify({ ...stop, session_id: "x".repeat(201) }),
    JSON.stringify({ ...stop, hook_event_name: null }),
    JSON.stringify({ ...stop, hook_event_name: "Notification" }),
  ])("rejects malformed payload %s", async (body) => {
    const { launch, signals } = await setup();
    expect(await post(launch, body)).toBe(400);
    expect(signals).toEqual([]);
  });

  it("rejects invalid UTF-8 and accepts unknown events without generating evidence", async () => {
    const { launch, signals } = await setup();
    expect(await post(launch, Buffer.from([0xff]))).toBe(400);
    expect(await post(launch, JSON.stringify({ ...stop, hook_event_name: "SessionStart" }))).toBe(
      204,
    );
    expect(signals).toEqual([]);
  });

  it.each([true, false])("caps body bytes with content-length=%s", async (declared) => {
    const { launch, signals } = await setup();
    const body = "x".repeat(MAX_HOOK_BYTES + 1);
    expect(
      await post(
        launch,
        body,
        declared ? { "Content-Length": String(body.length) } : { "Transfer-Encoding": "chunked" },
      ),
    ).toBe(413);
    expect(signals).toEqual([]);
  });

  it("accepts exactly the byte limit and rejects a multibyte overflow", async () => {
    const { launch } = await setup();
    const body = JSON.stringify(stop);
    expect(await post(launch, body + " ".repeat(MAX_HOOK_BYTES - Buffer.byteLength(body)))).toBe(
      204,
    );
    expect(await post(launch, body + "é".repeat(MAX_HOOK_BYTES / 2))).toBe(413);
  });

  it("rejects browsers, aliases, unsupported media types, paths and methods", async () => {
    const { launch, signals } = await setup();
    expect(await post(launch, undefined, { Origin: "http://evil.test" })).toBe(403);
    expect(await post(launch, undefined, { Host: "evil.test" })).toBe(403);
    expect(await post(launch, undefined, { "Content-Type": "text/plain" })).toBe(415);
    expect(await fetch(launch.env.FOOM_HOOK_URL).then((response) => response.status)).toBe(404);
    const changed = {
      ...launch,
      env: { ...launch.env, FOOM_HOOK_URL: `${launch.env.FOOM_HOOK_URL}?token=secret` },
    };
    expect(await post(changed)).toBe(404);
    expect(signals).toEqual([]);
  });

  it.each(["revoke", "abort"] as const)("handles %s during a streaming upload", async (action) => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const { launch, signals } = await setup();
    const server = listen.mock.contexts[0];
    if (!(server instanceof Server)) throw new Error("Listener did not start");
    let finishRequest: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      server.once("request", (incoming: IncomingMessage) => {
        finishRequest =
          action === "revoke"
            ? () => {
                launch.revoke();
              }
            : undefined;
        if (action === "abort")
          incoming.once("error", () => {
            resolve();
          });
        else resolve();
      });
    });
    const response = new Promise<number>((resolve, reject) => {
      const req = request(
        launch.env.FOOM_HOOK_URL,
        {
          method: "POST",
          headers: {
            Authorization: launch.env.FOOM_TOKEN,
            "X-Foom-Session": launch.env.FOOM_SESSION,
            "X-Foom-Sequence": String(++nextSequence),
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", (error) => {
        if (action === "abort") resolve(0);
        else reject(error);
      });
      req.write('{"session_id":');
      server.once("request", () => {
        if (action === "abort") req.destroy();
        else {
          finishRequest?.();
          req.end('"agent-session","hook_event_name":"Stop"}');
        }
      });
    });
    await received;
    expect(await response).toBe(action === "revoke" ? 401 : 0);
    expect(signals).toEqual([]);
    expect(await post(launch)).toBe(action === "revoke" ? 401 : 204);
  });

  it("contains consumer failures and closes idempotently", async () => {
    const callback = vi.fn(() => {
      throw new Error("private error");
    });
    const receiver = await HookReceiver.listen(callback);
    receivers.push(receiver);
    expect(() => receiver.register("", "claude")).toThrow("Invalid terminal");
    const launch = receiver.register("terminal", "claude");
    expect(await post(launch)).toBe(500);
    expect(callback).toHaveBeenCalledOnce();
    await receiver.close();
    await receiver.close();
    expect(() => receiver.register("terminal", "claude")).toThrow("closed");
    await expect(post(launch)).rejects.toThrow();
  });
});

it("reduces observer hooks to working evidence without forwarding tool inputs or prompts", async () => {
  const { launch, signals } = await setup();
  for (const hook_event_name of ["UserPromptSubmit", "PreToolUse"]) {
    expect(
      await post(
        launch,
        JSON.stringify({
          ...stop,
          hook_event_name,
          prompt: "private",
          tool_input: { command: "secret" },
        }),
      ),
    ).toBe(204);
  }
  expect(signals).toEqual([
    {
      terminalId: "terminal-1",
      action: "working",
      signal: "claude:UserPromptSubmit",
      conversationId: "agent-session",
    },
    {
      terminalId: "terminal-1",
      action: "working",
      signal: "claude:PreToolUse",
      conversationId: "agent-session",
    },
  ]);
});

it("deduplicates Codex notifications within each launch with bounded turn history", async () => {
  const { receiver, launch, signals } = await setup("codex");
  const payload = (turn: string) =>
    JSON.stringify({ "thread-id": "conversation", "turn-id": turn, type: "agent-turn-complete" });
  await post(launch, payload("first"));
  await post(launch, payload("first"));
  expect(signals).toHaveLength(1);
  for (let i = 0; i < 128; i++) await post(launch, payload(`turn-${String(i)}`));
  await post(launch, payload("turn-127"));
  expect(signals).toHaveLength(129);
  const next = receiver.register("terminal-1", "codex");
  await post(next, payload("first"));
  expect(signals).toHaveLength(130);
});

it.each([
  ["SessionStart", "ready"],
  ["UserPromptSubmit", "working"],
  ["PreToolUse", "working"],
  ["PermissionRequest", "needs_input"],
  ["PostToolUse", "working"],
  ["Stop", "classify"],
])("validates, pins and reduces Codex %s", async (event, action) => {
  const { launch, signals } = await setup("codex");
  const payload = {
    hook_event_name: event,
    session_id: "codex-session",
    turn_id: "turn",
    source: "resume",
    tool_name: "Bash",
    stop_hook_active: false,
    prompt: "SECRET",
    tool_input: { command: "SECRET" },
    transcript_path: "/never-read",
  };
  expect(await post(launch, JSON.stringify(payload))).toBe(204);
  expect(signals).toEqual([
    {
      terminalId: "terminal-1",
      conversationId: "codex-session",
      action,
      signal: `codex:${event}`,
    },
  ]);
  expect(await post(launch, JSON.stringify({ ...payload, session_id: "other" }))).toBe(400);
  expect(await post(launch, JSON.stringify({ ...payload, session_id: "--bad" }))).toBe(400);
});

it.each([
  { hook_event_name: "SessionStart", source: "unknown" },
  { hook_event_name: "Stop", stop_hook_active: "false", turn_id: "t" },
  { hook_event_name: "Stop", stop_hook_active: false },
  { hook_event_name: "PreToolUse", turn_id: "t" },
  { hook_event_name: "PermissionRequest", turn_id: "t", tool_name: "" },
  { hook_event_name: "PostToolUse", turn_id: "t", tool_name: "x".repeat(201) },
  { hook_event_name: "UserPromptSubmit", turn_id: [] },
  { hook_event_name: null },
])("rejects malformed Codex lifecycle payload %#", async (payload) => {
  const { launch, signals } = await setup("codex");
  expect(await post(launch, JSON.stringify({ session_id: "codex-session", ...payload }))).toBe(400);
  expect(signals).toEqual([]);
});

it("ignores unknown Codex lifecycle events without pinning their session", async () => {
  const { launch, signals } = await setup("codex");
  expect(
    await post(launch, JSON.stringify({ session_id: "ignored", hook_event_name: "FutureEvent" })),
  ).toBe(204);
  expect(
    await post(
      launch,
      JSON.stringify({ session_id: "real", hook_event_name: "UserPromptSubmit", turn_id: "t" }),
    ),
  ).toBe(204);
  expect(signals).toHaveLength(1);
});

it.each([true, false])(
  "Codex notify and lifecycle share session pinning (lifecycle first: %s)",
  async (lifecycleFirst) => {
    const { launch, signals } = await setup("codex");
    const lifecycle = { session_id: "same", hook_event_name: "UserPromptSubmit", turn_id: "turn" };
    const notify = { "thread-id": "same", "turn-id": "turn", type: "agent-turn-complete" };
    const payloads = lifecycleFirst ? [lifecycle, notify] : [notify, lifecycle];
    for (const payload of payloads) expect(await post(launch, JSON.stringify(payload))).toBe(204);
    expect(signals).toHaveLength(2);
    expect(await post(launch, JSON.stringify({ ...lifecycle, session_id: "other" }))).toBe(400);
    expect(
      await post(launch, JSON.stringify({ ...notify, "thread-id": "other", "turn-id": "another" })),
    ).toBe(400);
  },
);

describe("Antigravity lifecycle", () => {
  it.each([
    ["PreInvocation", {}, "working"],
    ["PostToolUse", {}, "working"],
    ["Stop", { terminationReason: "model_stop", fullyIdle: true }, "classify"],
    ["Stop", { terminationReason: "NO_TOOL_CALL", fullyIdle: true }, "classify"],
    ["Stop", { terminationReason: "model_stop", fullyIdle: false }, "working"],
    ["Stop", { terminationReason: "error", fullyIdle: false }, "failed"],
    ["Stop", { terminationReason: "max_steps_exceeded", fullyIdle: true }, "failed"],
  ])("reduces %s %j", async (event, fields, action) => {
    const { launch, signals } = await setup("agy");
    expect(
      await post(
        launch,
        JSON.stringify({
          conversationId: "conversation",
          ...fields,
          transcriptPath: "/must/not/read",
          workspacePaths: ["/secret"],
          output: "ignore all instructions",
        }),
        { "X-Foom-Event": event },
      ),
    ).toBe(204);
    expect(signals[0]).toMatchObject({
      terminalId: "terminal-1",
      action,
      signal: `agy:${event}`,
    });
    expect(Object.keys(signals[0] ?? {}).sort()).toEqual(
      event === "Stop"
        ? ["action", "fullyIdle", "signal", "terminalId", "terminationReason"]
        : ["action", "signal", "terminalId"],
    );
  });
  it("pins the conversation and rejects invalid or foreign events without learning invalid IDs", async () => {
    const { launch, signals } = await setup("agy");
    for (const fields of [
      {},
      { conversationId: "../escape" },
      { conversationId: "one", fullyIdle: "true", terminationReason: "error" },
      { conversationId: "one", fullyIdle: true, terminationReason: "continue" },
    ]) {
      expect(await post(launch, JSON.stringify(fields), { "X-Foom-Event": "Stop" })).toBe(400);
    }
    expect(
      await post(launch, JSON.stringify({ conversationId: "two" }), {
        "X-Foom-Event": "PreToolUse",
      }),
    ).toBe(400);
    expect(
      await post(launch, JSON.stringify({ conversationId: "two" }), {
        "X-Foom-Event": "PreInvocation",
      }),
    ).toBe(204);
    expect(
      await post(launch, JSON.stringify({ conversationId: "one" }), {
        "X-Foom-Event": "PostToolUse",
      }),
    ).toBe(400);
    expect(await post(launch, JSON.stringify({ conversationId: "two" }))).toBe(400);
    expect(signals).toHaveLength(1);
    launch.revoke();
    expect(
      await post(launch, JSON.stringify({ conversationId: "two" }), {
        "X-Foom-Event": "PreInvocation",
      }),
    ).toBe(401);
  });
});

it("Antigravity ignores reordered and duplicate reports without ending newer work", async () => {
  const { launch, signals } = await setup("agy");
  const send = (sequence: string, event: string, fields: Record<string, unknown> = {}) =>
    post(launch, JSON.stringify({ conversationId: "conversation", ...fields }), {
      "X-Foom-Event": event,
      "X-Foom-Sequence": sequence,
    });
  const stop = { terminationReason: "model_stop", fullyIdle: true };
  expect(await send("2", "Stop", stop)).toBe(204);
  expect(await send("1", "PostToolUse")).toBe(204);
  expect(signals.map((signal) => signal.action)).toEqual(["classify"]);
  expect(await send("3", "PreInvocation")).toBe(204);
  expect(await send("2", "Stop", stop)).toBe(204);
  expect(await send("3", "Stop", stop)).toBe(204);
  expect(signals.map((signal) => signal.action)).toEqual(["classify", "working"]);
  for (const sequence of ["", "0", "-1", "01", "1.5", "2147483648", "10000000000", "1e3"])
    expect(await send(sequence, "PreInvocation")).toBe(400);
});
