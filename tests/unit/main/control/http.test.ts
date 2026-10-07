import { request } from "node:http";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ControlHttp } from "../../../../src/main/control/http";
import { ControlService } from "../../../../src/main/control/service";
import { Operations } from "../../../../src/main/control/operations";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";

let service: ControlService;
let http: ControlHttp;
let token: string;
let revoke: () => void;
beforeEach(async () => {
  service = new ControlService(
    new Operations(
      () => Promise.resolve(),
      (actor) => {
        service.assertActive(actor);
      },
    ),
  );
  http = await ControlHttp.listen(service);
  const grant = service.prepare(tmpdir(), tmpdir());
  grant.bind("terminal");
  token = grant.env["FOOM_CONTROL_TOKEN"] ?? "";
  revoke = () => {
    grant.dispose();
  };
});
afterEach(async () => {
  await http.close();
});
const body = () =>
  JSON.stringify({ version: 1, instanceId: service.instanceId, method: "whoami", params: {} });
function call(
  data: string | Buffer = body(),
  headers: Record<string, string> = {},
  suffix = "",
  method = "POST",
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      http.endpoint + suffix,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let result = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          result += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, data: result });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
it("serves identity without secrets, revokes shutdown and rejects stale instances", async () => {
  expect((await call()).status).toBe(200);
  expect((await call()).data).not.toContain(token);
  expect((await call(body().replace(service.instanceId, "stale"))).status).toBe(400);
  revoke();
  expect((await call()).status).toBe(401);
  await http.close();
  await http.close();
  expect(() => service.authenticate(token)).toThrow("unauthorized");
});
it.each([
  [{ origin: "null" }, "", "POST", 403],
  [{ host: "localhost" }, "", "POST", 403],
  [{ authorization: "invalid" }, "", "POST", 401],
  [{ authorization: "Bearer unknown" }, "", "POST", 401],
  [{ "content-type": "text/plain" }, "", "POST", 415],
  [{ "content-length": "65537" }, "", "POST", 413],
  [{}, "?token=secret", "POST", 404],
  [{}, "", "GET", 404],
] as const)("rejects invalid transport %j %s %s", async (headers, suffix, method, status) => {
  expect((await call(body(), headers, suffix, method)).status).toBe(status);
});
it("bounds streamed bodies and headers, rejects malformed JSON and UTF-8", async () => {
  expect((await call("x".repeat(65537))).status).toBe(413);
  expect((await call("{")).status).toBe(400);
  expect((await call(Buffer.from([0xff, 0xfe]))).status).toBe(400);
  expect((await call(body(), { "x-large": "x".repeat(9000) })).status).toBe(431);
  expect((await call(body().replace("whoami", "stop"))).status).toBe(403);
});
it("rechecks revocation after authenticating a partial body", async () => {
  const accepted = Promise.withResolvers<undefined>();
  const reserve = service.reserve.bind(service);
  vi.spyOn(service, "reserve").mockImplementation((actor) => {
    const release = reserve(actor);
    accepted.resolve(undefined);
    return release;
  });
  const result = Promise.withResolvers<number>();
  const req = request(
    http.endpoint,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    },
    (res) => {
      res.resume();
      res.on("end", () => {
        result.resolve(res.statusCode ?? 0);
      });
    },
  );
  req.on("error", result.reject);
  req.write(body().slice(0, 10));
  await accepted.promise;
  revoke();
  req.end(body().slice(10));
  expect(await result.promise).toBe(401);
});
it("releases the grant's capacity after an aborted upload", async () => {
  const accepted = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const reserve = service.reserve.bind(service);
  vi.spyOn(service, "reserve").mockImplementationOnce((actor) => {
    const release = reserve(actor);
    accepted.resolve(undefined);
    return () => {
      release();
      released.resolve(undefined);
    };
  });
  const req = request(http.endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  req.on("error", () => undefined);
  req.write("{");
  await accepted.promise;
  req.destroy();
  await released.promise;
  const actor = service.authenticate(token);
  const releases = Array.from({ length: 4 }, () => service.reserve(actor));
  releases.forEach((release) => {
    release();
  });
});

it("shares service concurrency limits with the transport", async () => {
  const actor = service.authenticate(token);
  const releases = Array.from({ length: 4 }, () => service.reserve(actor));
  expect((await call()).status).toBe(429);
  releases.forEach((release) => {
    release();
  });
  expect((await call()).status).toBe(200);
});
it("keeps hook and control audiences separate", async () => {
  const hooks = await HookReceiver.listen(() => undefined);
  try {
    const hook = hooks.register("terminal", "claude");
    expect((await call(body(), { authorization: `Bearer ${hook.env.FOOM_TOKEN}` })).status).toBe(
      401,
    );
    const response = await fetch(hook.env.FOOM_HOOK_URL, {
      method: "POST",
      headers: {
        Authorization: token,
        "X-Foom-Session": hook.env.FOOM_SESSION,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
  } finally {
    await hooks.close();
  }
});
it("bounds a chunked upload without a content length", async () => {
  const result = await new Promise<number>((resolve, reject) => {
    const req = request(
      http.endpoint,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
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
    req.write("x".repeat(65537));
    req.end();
  });
  expect(result).toBe(413);
});
it("exposes only an actor's operation lookup over HTTP", async () => {
  const grant = service.prepare(tmpdir(), tmpdir(), "orchestrator");
  grant.bind("orchestrator");
  token = grant.env["FOOM_CONTROL_TOKEN"] ?? "";
  const actor = service.authenticate(token);
  const op = await service.operations.begin(actor, "stop", "key", "{}");
  const lookup = (id: string) =>
    JSON.stringify({
      version: 1,
      instanceId: service.instanceId,
      method: "operation_status",
      params: { operationId: id },
    });
  expect((await call(lookup(op.operationId))).status).toBe(200);
  expect((await call(lookup("foreign"))).status).toBe(404);
});
