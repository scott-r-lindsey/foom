/** The stdio bridge's complete JSON response bound, also used to budget pages. */
export const MCP_RESPONSE_LIMIT = 256 * 1024;
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
