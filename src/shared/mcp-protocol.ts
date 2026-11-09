/** Supported wire versions, newest preferred when a client proposes another version. */
export const MCP_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];
export function negotiateMcpVersion(requested: string): string {
  return MCP_VERSIONS.includes(requested) ? requested : "2025-11-25";
}

/** Fixed diagnostic vocabulary; never reflect client keys, values or exception messages. */
export const MCP_ERROR_FIELDS = [
  "request",
  "jsonrpc",
  "method",
  "id",
  "params",
  "params._meta",
  "params._meta.progressToken",
  "params.protocolVersion",
  "params.capabilities",
  "params.clientInfo",
  "params.clientInfo.name",
  "params.clientInfo.version",
  "params.cursor",
  "params.name",
  "params.arguments",
  "params.task",
  "mcp-session-id",
  "mcp-protocol-version",
] as const;
export const MCP_HTTP_ERRORS = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "capacity",
  "unavailable",
];
