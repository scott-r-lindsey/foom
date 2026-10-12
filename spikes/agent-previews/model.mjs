// Scripted loopback model for the #222 spike: speaks the Anthropic Messages and
// OpenAI Responses streaming formats well enough to make real CLIs call tools.
// It never contacts a provider.
import { createServer } from "node:http";

/** script: [{ tool, input }], called in order; afterwards the model ends the turn. */
export async function startModel(SCRIPT) {
  const seen = { toolsOffered: [], toolResults: [], requests: 0, waitResults: [] };

  const step = (count) => SCRIPT[count];

  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    seen.requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    if (req.url?.includes("messages")) {
      // Anthropic Messages API (Claude Code).
      seen.allTools = (body.tools ?? []).map((t) => t.name ?? t.type);
      seen.deferredMention = JSON.stringify(body.system ?? "").concat(JSON.stringify(body.messages ?? "")).match(/.{0,200}mcp__foom_[0-9a-f]+__open_preview.{0,120}/)?.[0]?.replace(/foom_[0-9a-f]+/g, "foom_…") ?? null;
      const offered = (body.tools ?? []).filter((t) => /^mcp__foom_/.test(t.name ?? ""));
      if (offered.length) seen.toolsOffered = offered.map((t) => ({ name: t.name.replace(/^mcp__foom_[0-9a-f]+__/, "mcp__foom_…__"), description: t.description }));
      const allResults = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "tool_result");
      const waits = allResults.filter((r) => r.tool_use_id.startsWith("wait_"));
      const results = allResults.filter((r) => !r.tool_use_id.startsWith("wait_"));
      seen.waitSchema = (body.tools ?? []).find((t) => t.name === "WaitForMcpServers")?.input_schema ?? seen.waitSchema;
      seen.waitResults = waits.map((r) => (typeof r.content === "string" ? r.content : r.content?.map((c) => c.text).join("")));
      seen.toolResults = results.map((r) => ({ is_error: r.is_error ?? false, content: typeof r.content === "string" ? r.content : r.content?.map((c) => c.text).join("") }));
      const next = step(results.length);
      let tool = next && offered.find((t) => t.name.endsWith(`__${next.tool}`));
      let toolInput = next?.input;
      let toolId = `tool_${results.length}`;
      // Interactive Claude Code may send the first turn before MCP connects; a real
      // model would wait for servers, so the script does too (at most three times).
      if (!offered.length && waits.length < 3 && (body.tools ?? []).some((t) => t.name === "WaitForMcpServers")) {
        tool = { name: "WaitForMcpServers" };
        toolInput = {};
        toolId = `wait_${waits.length}`;
      }
      event("message_start", { message: { id: "msg_s", type: "message", role: "assistant", content: [], model: "synthetic", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      if (tool) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: toolId, name: tool.name, input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Synthetic run complete." } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      event("message_stop", {});
    } else {
      // OpenAI Responses API (Codex). MCP tools may arrive inside a namespace.
      const flat = (body.tools ?? []).flatMap((t) => (t.type === "namespace" ? t.tools.map((x) => ({ ...x, namespace: t.name })) : [t]));
      const offered = flat.filter((t) => (t.namespace ?? t.name ?? "").includes("foom_"));
      if (offered.length) seen.toolsOffered = offered.map((t) => ({ name: t.name.replace(/foom_[0-9a-f]+/, "foom_…"), description: t.description }));
      const results = (body.input ?? []).filter((i) => i.type === "function_call_output");
      seen.toolResults = results.map((r) => ({ content: typeof r.output === "string" ? r.output : JSON.stringify(r.output) }));
      const next = step(results.length);
      const tool = next && offered.find((t) => t.name === next.tool || t.name.endsWith(`__${next.tool}`));
      const output = tool
        ? { type: "function_call", id: `fc_${results.length}`, call_id: `call_${results.length}`, ...(tool.namespace ? { namespace: tool.namespace } : {}), name: tool.name, arguments: JSON.stringify(next.input), status: "completed" }
        : { type: "message", id: "msg_s", role: "assistant", content: [{ type: "output_text", text: "Synthetic run complete.", annotations: [] }], status: "completed" };
      event("response.created", { response: { id: "resp_s", object: "response", status: "in_progress", output: [] } });
      event("response.output_item.added", { output_index: 0, item: output });
      event("response.output_item.done", { output_index: 0, item: output });
      event("response.completed", { response: { id: "resp_s", object: "response", status: "completed", output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    }
    res.end();
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelUrl = `http://127.0.0.1:${model.address().port}`;
  return {
    url: modelUrl,
    seen,
    reset() {
      Object.assign(seen, { toolsOffered: [], toolResults: [], requests: 0, waitResults: [] });
    },
    close() {
      model.close();
      model.closeAllConnections();
    },
  };
}
