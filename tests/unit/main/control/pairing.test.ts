import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { Pairing } from "../../../../src/main/control/pairing";
import { ControlService } from "../../../../src/main/control/service";
import { ControlHttp } from "../../../../src/main/control/http";
import { Operations } from "../../../../src/main/control/operations";
import type { PairingOptions } from "../../../../src/main/control/types";

let service: ControlService;
let pairing: Pairing;
const approve = vi.fn<PairingOptions["approve"]>();
const repository = vi.fn((path: string) => (path === tmpdir() ? path : undefined));
const announce = vi.fn<(code: string, expiresAt: number) => void>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  approve.mockResolvedValue(true);
  repository.mockImplementation((path) => (path === tmpdir() ? path : undefined));
  service = new ControlService(
    new Operations(
      () => Promise.resolve(),
      (actor) => {
        service.assertActive(actor);
      },
    ),
  );
  pairing = new Pairing(service, { approve, repository });
});
afterEach(() => {
  pairing.close();
  service.close();
  vi.useRealTimers();
});
const body = () => ({ version: 1, instanceId: service.instanceId, repository: tmpdir() });
const pair = () => pairing.pair(body(), new AbortController().signal, announce);
it("binds matching code to an immutable read-only repository grant, never a terminal capability", async () => {
  const grant = await pair();
  expect(announce).toHaveBeenCalledWith(
    expect.stringMatching(/^[A-F0-9]{8}$/u),
    Date.now() + 60000,
  );
  expect(approve).toHaveBeenCalledWith(
    tmpdir(),
    announce.mock.calls[0]?.[0],
    expect.any(AbortSignal),
  );
  const actor = service.authenticate(grant.token);
  expect(actor).toMatchObject({ role: "cli", repository: tmpdir(), parentId: null });
  expect(
    service.dispatch(actor, {
      version: 1,
      instanceId: service.instanceId,
      method: "whoami",
      params: {},
    }),
  ).toMatchObject({ capabilities: ["whoami", "sessions", "session_state"] });
  expect(() =>
    service.dispatch(actor, {
      version: 1,
      instanceId: service.instanceId,
      method: "operation_status",
      params: {},
    }),
  ).toThrow("forbidden");
  vi.setSystemTime(grant.expiresAt);
  expect(() => service.authenticate(grant.token)).toThrow("unauthorized");
  expect(() => service.reserve(actor)).toThrow("unauthorized");
});
it("rejects denied, failed, expired and cancelled reviews and dismisses the dialog", async () => {
  approve.mockResolvedValueOnce(false);
  await expect(pair()).rejects.toThrow("forbidden");
  await vi.advanceTimersByTimeAsync(10000);
  approve.mockRejectedValueOnce(new Error("dialog failed"));
  await expect(pair()).rejects.toThrow("dialog failed");
  await vi.advanceTimersByTimeAsync(10000);
  approve.mockImplementationOnce(() => new Promise(() => {}));
  const pending = expect(pair()).rejects.toThrow("forbidden");
  await expect(pair()).rejects.toThrow("capacity");
  await vi.advanceTimersByTimeAsync(60000);
  await pending;
  expect(approve.mock.calls.at(-1)?.[2].aborted).toBe(true);
  approve.mockImplementationOnce(() => new Promise(() => {}));
  const controller = new AbortController();
  const cancelled = expect(pairing.pair(body(), controller.signal, announce)).rejects.toThrow(
    "forbidden",
  );
  controller.abort();
  await cancelled;
  await expect(pairing.pair(body(), controller.signal, announce)).rejects.toThrow("unavailable");
});
it("rechecks repository registration, clock deadlines and shutdown after review", async () => {
  approve.mockImplementationOnce(() => {
    repository.mockReturnValue(undefined);
    return Promise.resolve(true);
  });
  await expect(pair()).rejects.toThrow("forbidden");
  repository.mockImplementation((path) => (path === tmpdir() ? path : undefined));
  await vi.advanceTimersByTimeAsync(10000);
  approve.mockImplementationOnce(() => {
    vi.setSystemTime(Date.now() + 60000);
    return Promise.resolve(true);
  });
  await expect(pair()).rejects.toThrow("forbidden");
  approve.mockImplementationOnce(() => new Promise(() => {}));
  const pending = expect(pair()).rejects.toThrow("forbidden");
  pairing.close();
  await pending;
  await expect(pair()).rejects.toThrow("unavailable");
});
it("bounds grants and removes expired credentials", async () => {
  const grants = Array.from({ length: 4 }, () => service.grantCli(tmpdir()));
  expect(() => service.grantCli(tmpdir())).toThrow("capacity");
  await vi.advanceTimersByTimeAsync(600000);
  for (const grant of grants)
    expect(() => service.authenticate(grant.token)).toThrow("unauthorized");
  expect(service.grantCli(tmpdir()).token).not.toBe(grants[0]?.token);
});
it("validates negotiation, unknown fields, repository scope and rate limits before prompting", async () => {
  for (const value of [
    null,
    {},
    { ...body(), version: 2 },
    { ...body(), instanceId: "old" },
    { ...body(), repository: 5 },
    { ...body(), repository: "x".repeat(4097) },
    { ...body(), role: "orchestrator" },
  ])
    await expect(pairing.pair(value, new AbortController().signal, announce)).rejects.toThrow(
      "invalid_request",
    );
  await expect(
    pairing.pair({ ...body(), repository: "/foreign" }, new AbortController().signal, announce),
  ).rejects.toThrow("not_found");
  await expect(pair()).rejects.toThrow("capacity");
  expect(approve).not.toHaveBeenCalled();
});
it("serves bounded pairing over the pending connection and rejects authenticated/browser requests", async () => {
  vi.useRealTimers();
  const http = await ControlHttp.listen(service, { repository, approve });
  const send = (data: string | Buffer, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        `${http.endpoint}/pair`,
        { method: "POST", headers: { "content-type": "application/json", ...headers } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, text });
          });
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  try {
    expect((await send(JSON.stringify(body()), { authorization: "Bearer agent" })).status).toBe(
      403,
    );
    expect((await send(JSON.stringify(body()), { origin: "null" })).status).toBe(403);
    expect((await send("{}", { "content-type": "text/plain" })).status).toBe(400);
    expect((await send("x".repeat(4097), { "content-length": "4097" })).status).toBe(400);
    expect((await send("x".repeat(4097), { "transfer-encoding": "chunked" })).status).toBe(413);
    expect((await send(Buffer.from([255]))).text).toContain("invalid_request");
    expect((await send("{")).text).toContain("invalid_request");
    const good = await send(JSON.stringify(body()));
    expect(good.status).toBe(200);
    expect(good.text.split("\n")).toHaveLength(3);
    expect(good.text).toContain('"grant"');
    expect((await send(JSON.stringify(body()))).status).toBe(429);
  } finally {
    await http.close();
  }
});

it("explicit CLI release revokes only that principal and is unavailable to agents", () => {
  const grant = service.grantCli(tmpdir());
  const actor = service.authenticate(grant.token);
  const request = { version: 1, instanceId: service.instanceId, method: "release_cli", params: {} };
  expect(service.dispatch(actor, request)).toEqual({ released: true });
  expect(() => service.authenticate(grant.token)).toThrow("unauthorized");
  const launch = service.prepare(tmpdir(), tmpdir());
  launch.bind("agent");
  expect(() =>
    service.dispatch(service.authenticate(launch.env["FOOM_CONTROL_TOKEN"] ?? ""), request),
  ).toThrow("forbidden");
});
