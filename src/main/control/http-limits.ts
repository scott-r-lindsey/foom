import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import { ControlError } from "../../shared/control-validation";

/** Transport limits only; sharing these helpers conveys no control authority. */
export function boundedHttpServer(listener: RequestListener) {
  const server = createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: 1000 }, listener);
  server.maxConnections = 32;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  server.keepAliveTimeout = 1000;
  return server;
}

/** Reserve before consuming a body; release on response close or request error. */
export function reserveRequest(state: { calls: number }): () => void {
  if (state.calls >= 4) throw new ControlError("capacity");
  state.calls++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      state.calls--;
    }
  };
}
