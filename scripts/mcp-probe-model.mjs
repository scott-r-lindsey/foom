// Deterministic synthetic model decisions; never calls a CLI or a provider.
export function claudeToolCall(body, completed) {
  if (completed >= 2) return undefined;
  const name = completed === 0 ? "whoami" : "open_preview";
  const tool = body.tools?.find(
    (entry) => entry.name?.startsWith("mcp__foom_") && entry.name.endsWith(`__${name}`),
  );
  if (tool)
    return {
      id: `tool_probe_${completed}`,
      name: tool.name,
      input: name === "whoami" ? {} : { path: "probe.html" },
    };

  // Since Claude 2.1.304, custom model endpoints also use deferred MCP tools.
  // Let the real client discover them, rather than bypassing tool search or MCP.
  const searched = body.messages?.some((message) =>
    Array.isArray(message.content)
      ? message.content.some((block) => block.type === "tool_use" && block.name === "ToolSearch")
      : false,
  );
  if (!searched && body.tools?.some((entry) => entry.name === "ToolSearch"))
    return {
      id: "tool_probe_search",
      name: "ToolSearch",
      input: { query: "foom", max_results: 100 },
    };
  // Managed policy may leave no tools to discover. End instead of searching forever;
  // the caller still asserts every authenticated call in the permitted launch.
  return undefined;
}
