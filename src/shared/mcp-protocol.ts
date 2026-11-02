/** Supported wire versions, newest preferred when a client proposes another version. */
export const MCP_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];
export function negotiateMcpVersion(requested: string): string {
  return MCP_VERSIONS.includes(requested) ? requested : "2025-11-25";
}
