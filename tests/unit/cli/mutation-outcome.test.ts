import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { call } from "../../../src/cli/client";
import { execute } from "../../../src/cli/execute";
import { run } from "../../../src/cli/cli";

afterEach(() => vi.useRealTimers());

it.each(["create_worktree", "launch", "stop", "close", "remove_worktree", "prompt", "send_keys"])(
  "%s reports an unknown outcome after timeout and recovers success using the same key",
  async (method) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requests: unknown[] = [];
    let accepted: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const operation = { operationId: "op", status: "succeeded", resultId: "child" };
    const server = createServer((req, res) => {
      void (async () => {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        const value: unknown = JSON.parse(body);
        requests.push(value);
        if (requests.length === 1) {
          accepted?.();
          // The action succeeds even though the response arrives after the client deadline.
          setTimeout(() => res.end(JSON.stringify({ result: operation })), 61000);
        } else res.end(JSON.stringify({ result: operation }));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("address");
    const connection = {
      endpoint: `http://127.0.0.1:${String(address.port)}/control/v1`,
      token: "a".repeat(64),
      instanceId: "instance",
    };
    try {
      const result = call(connection, { method, params: { idempotencyKey: "same-key" } });
      const rejected = expect(result).rejects.toMatchObject({
        message: "unknown_outcome",
        idempotencyKey: "same-key",
      });
      await received;
      await vi.advanceTimersByTimeAsync(59000);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        await call(connection, {
          method: "operation_status",
          params: { idempotencyKey: "same-key" },
        }),
      ).toEqual(operation);
      expect(requests).toEqual([
        { version: 1, instanceId: "instance", method, params: { idempotencyKey: "same-key" } },
        {
          version: 1,
          instanceId: "instance",
          method: "operation_status",
          params: { idempotencyKey: "same-key" },
        },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  },
);

it.each(["lost", "partial", "malformed", "empty", "failed", "success"])(
  "preserves confirmed results and distinguishes %s mutation responses in the console",
  async (mode) => {
    const operation = { status: "succeeded", operationId: "op" };
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (mode === "lost") res.destroy();
        else if (mode === "partial") {
          res.writeHead(200, { "content-length": "1000" });
          res.write('{"result":');
          setImmediate(() => res.destroy());
        } else
          res.end(
            mode === "malformed"
              ? "{"
              : mode === "empty"
                ? "{}"
                : JSON.stringify(mode === "failed" ? { error: "conflict" } : { result: operation }),
          );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("address");
    const out = vi.fn();
    const error = vi.fn();
    try {
      const code = await execute(
        ["launch", "tree", "--agent", "codex", "--idempotency-key", "same-key"],
        "1",
        {
          out,
          error,
          input: (async function* () {})(),
        },
        {
          FOOM_CONTROL_URL: `http://127.0.0.1:${String(address.port)}/control/v1`,
          FOOM_CONTROL_TOKEN: "a".repeat(64),
          FOOM_CONTROL_INSTANCE: "instance",
        },
        "/foom",
      );
      expect(code).toBe(mode === "success" ? 0 : mode === "failed" ? 4 : 6);
      if (mode === "success")
        expect(out).toHaveBeenCalledWith(JSON.stringify({ result: operation }) + "\n");
      else
        expect(error).toHaveBeenCalledWith(
          JSON.stringify(
            mode === "failed"
              ? { error: "conflict" }
              : {
                  error: "unknown_outcome",
                  idempotencyKey: "same-key",
                },
          ) + "\n",
        );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  },
);

it("explains same-key recovery and the distinct exit status in help", () => {
  expect(run(["--help"], "1").output).toContain("Exit 6 (unknown_outcome)");
  expect(run(["--help"], "1").output).toContain("never retry with a new key");
});

it("waits for a normal slow launch beyond the old five-second deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const received = Promise.withResolvers<undefined>();
  const operation = { status: "succeeded", resultId: "child" };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      setTimeout(() => res.end(JSON.stringify({ result: operation })), 40000);
      received.resolve(undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  try {
    const result = call(
      {
        endpoint: `http://127.0.0.1:${String(address.port)}/control/v1`,
        token: "a".repeat(64),
        instanceId: "instance",
      },
      { method: "launch", params: { idempotencyKey: "key" } },
    );
    await received.promise;
    await vi.advanceTimersByTimeAsync(40000);
    expect(await result).toEqual(operation);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});
