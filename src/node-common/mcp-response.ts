import { MCP_RESPONSE_LIMIT } from "../shared/mcp-protocol";

export { MCP_RESPONSE_LIMIT };

export const MCP_ID_LIMIT = 200;

/** Preserve both MCP representations when measuring or sending a tool result. */
export function mcpToolResponse(id: unknown, value: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    },
  };
}

/** Reserve the largest valid JSON-RPC ID, including JSON escaping. */
export function fitsMcpToolResponse(value: unknown): boolean {
  return (
    Buffer.byteLength(JSON.stringify(mcpToolResponse("\u0000".repeat(MCP_ID_LIMIT), value))) <=
    MCP_RESPONSE_LIMIT
  );
}
