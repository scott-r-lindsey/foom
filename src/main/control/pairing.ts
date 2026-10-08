import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlService } from "./service";
import { ControlError, exact, object } from "./validation";

import type { PairingOptions } from "./types";

/** No reusable human credentials: one bounded, cancellable trusted review at a time. */
export class Pairing {
  private pending: AbortController | undefined;
  private next = 0;
  private closed = false;
  constructor(
    private readonly service: ControlService,
    private readonly options: PairingOptions,
  ) {}

  close(): void {
    this.closed = true;
    this.pending?.abort();
  }

  async pair(
    input: unknown,
    signal: AbortSignal,
    announce: (code: string, expiresAt: number) => void,
  ): Promise<{ token: string; expiresAt: number }> {
    const value = object(input);
    exact(value, ["version", "instanceId", "repository"]);
    if (
      value["version"] !== 1 ||
      value["instanceId"] !== this.service.instanceId ||
      typeof value["repository"] !== "string" ||
      value["repository"].length > 4096
    )
      throw new ControlError("invalid_request");
    if (this.closed || signal.aborted) throw new ControlError("unavailable");
    if (this.pending || Date.now() < this.next) throw new ControlError("capacity");
    this.next = Date.now() + 10000;
    const repository = this.options.repository(value["repository"]);
    if (!repository) throw new ControlError("not_found");
    const pending = new AbortController();
    this.pending = pending;
    const cancel = () => {
      pending.abort();
    };
    signal.addEventListener("abort", cancel, { once: true });
    const expiresAt = Date.now() + 60000;
    const timer = setTimeout(cancel, 60000);
    const code = randomBytes(4).toString("hex").toUpperCase();
    try {
      announce(code, expiresAt);
      const aborted = new Promise<false>((resolve) => {
        pending.signal.addEventListener(
          "abort",
          () => {
            resolve(false);
          },
          { once: true },
        );
      });
      const accepted = await Promise.race([
        this.options.approve(repository, code, pending.signal),
        aborted,
      ]);
      if (
        !accepted ||
        pending.signal.aborted ||
        Date.now() >= expiresAt ||
        this.options.repository(repository) !== repository
      )
        throw new ControlError("forbidden");
      return this.service.grantCli(repository);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      pending.abort();
      this.pending = undefined;
    }
  }

  receive(request: IncomingMessage, response: ServerResponse): void {
    const send = (value: unknown) => {
      response.write(`${JSON.stringify(value)}\n`);
    };
    const fail = (status: number, error: string) => {
      if (!response.headersSent)
        response.writeHead(status, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-store",
          Connection: "close",
        });
      send({ error });
      response.end();
    };
    if (request.headers.authorization !== undefined) {
      fail(403, "forbidden");
      return;
    }
    if (
      request.headers["content-type"] !== "application/json" ||
      Number(request.headers["content-length"]) > 4096
    ) {
      fail(400, "invalid_request");
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    const controller = new AbortController();
    response.once("close", () => {
      controller.abort();
    });
    request.on("error", () => {
      controller.abort();
    });
    request.on("data", (chunk: Buffer) => {
      if (response.writableEnded) return;
      size += chunk.length;
      if (size > 4096) {
        chunks.length = 0;
        fail(413, "invalid_request");
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      void (async () => {
        try {
          const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
          );
          const grant = await this.pair(value, controller.signal, (code, expiresAt) => {
            response.writeHead(200, {
              "Content-Type": "application/x-ndjson",
              "Cache-Control": "no-store",
              Connection: "close",
            });
            response.setTimeout(65000);
            send({ pairing: { code, expiresAt } });
          });
          send({ grant });
          response.end();
        } catch (error) {
          fail(
            error instanceof ControlError && error.code === "capacity" ? 429 : 400,
            error instanceof ControlError ? error.code : "invalid_request",
          );
        }
      })();
    });
  }
}
