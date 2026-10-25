import { randomUUID } from "node:crypto";
import type { Principal } from "./types";
import type { ControlService } from "./service";
import { ControlError } from "../../shared/control-validation";
import { remoteControlResult } from "../../shared/remote-agent-protocol";
import type { RemoteControlResult } from "../../shared/remote-agent";

/** Captured by the hub's launch capability, never looked up from a remote-selected ID. */
export function remoteChildControl(service: ControlService, actor: () => Principal) {
  const alias = randomUUID();
  return async (method: string, params: unknown): Promise<RemoteControlResult> => {
    let release: (() => void) | undefined;
    try {
      const principal = actor();
      service.assertActive(principal);
      if (
        principal.role !== "agent" ||
        principal.parentId === null ||
        !service.capabilities(principal).includes("handoff")
      )
        return { type: "error", error: "no_parent" };
      release = service.reserve(principal);
      if (!["whoami", "manual", "handoff", "mcp_connected"].includes(method))
        return { type: "error", error: "phase_2_restricted" };
      // Identity params still pass the ordinary exact-field validator. Its result
      // is deliberately discarded rather than copied or edited.
      const value = await service.call(principal, {
        version: 1,
        instanceId: service.instanceId,
        method: method === "mcp_connected" ? "whoami" : method,
        params,
      });
      service.assertActive(principal);
      let result: unknown;
      if (method === "mcp_connected") service.mcpConnected(principal);
      if (method === "whoami" || method === "mcp_connected")
        result = {
          type: "identity",
          alias,
          role: "child",
          capabilities: ["whoami", "manual", "handoff"],
        };
      else if (method === "manual") result = { type: "manual", value };
      else
        result =
          typeof value === "object" && value !== null ? { ...value, type: "handoff" } : undefined;
      if (!remoteControlResult(result)) return { type: "error", error: "unavailable" };
      // Defense in depth: no future service field or static manual page can leak
      // this launch's daemon takeover ID or its parent's hub identity.
      const serialized = JSON.stringify(result);
      if ([principal.terminalId, principal.parentId].some((id) => serialized.includes(id)))
        return { type: "error", error: "unavailable" };
      return result;
    } catch (error) {
      const code = error instanceof ControlError ? error.code : "unavailable";
      return {
        type: "error",
        error:
          code === "unauthorized" || code === "no_parent" || code === "invalid_request"
            ? code
            : "unavailable",
      };
    } finally {
      release?.();
    }
  };
}
