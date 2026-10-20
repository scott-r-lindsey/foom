// A fixture CLI: only loopback probe attachments and its disposable scratch cwd.
const fs = require("node:fs");
const readline = require("node:readline");
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const session = process.argv.includes("--resume")
  ? argument("--resume")
  : process.execArgv[process.execArgv.indexOf("--title") + 1];
const screen = (text) => process.stdout.write(`\x1b[2J\x1b[H\x1b]0;Fixture\x07${text}`);
const hook = async (event) => {
  const response = await fetch(process.env.FOOM_HOOK_URL, {
    method: "POST",
    headers: {
      authorization: process.env.FOOM_TOKEN,
      "X-Foom-Session": process.env.FOOM_SESSION,
      "X-Foom-Channel": "lifecycle",
      "content-type": "application/json",
    },
    body: JSON.stringify({ session, event, privateValue: "DO_NOT_RETAIN" }),
  });
  if (response.status !== 204) throw Error(`Hook refused: ${response.status}`);
};
(async () => {
  const server = Object.values(
    JSON.parse(fs.readFileSync(process.env.AGENT_CONFIG, "utf8")).mcpServers,
  )[0];
  let mcpSession;
  const mcp = async (method, params, id = 1) =>
    fetch(server.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.FOOM_CONTROL_TOKEN}`,
        "content-type": "application/json",
        ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        ...(method.startsWith("notifications/") ? {} : { id }),
      }),
    });
  const initialized = await mcp("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  mcpSession = initialized.headers.get("mcp-session-id");
  await mcp("notifications/initialized", {}, undefined);
  const listed = await (await mcp("tools/list", {})).json();
  if (listed.result.tools.length !== 1 || listed.result.tools[0].name !== "ping")
    throw Error("Unexpected tools");
  await mcp("tools/call", { name: "ping", arguments: {} });
  await hook("ready");
  screen(process.argv.includes("--resume") ? `Resumed ${session}` : "Fixture ready");
  let pending = Promise.resolve();
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    pending = pending
      .then(async () => {
        if (line === "work") {
          await hook("start");
          screen("Working on scratch task");
        } else if (line === "permission") {
          await hook("permission");
          screen("Allow scratch write? Working");
        } else if (line === "approve") {
          fs.writeFileSync("harmless.txt", "fixture only");
          await hook("stop");
          screen("Task complete. Ready for input");
        }
      })
      .catch((error) => {
        console.error(error);
        fs.writeFileSync(require("node:path").join(__dirname, "agent-error.json"), error.stack);
        process.stdin.resume();
      });
  });
})().catch((error) => {
  console.error(error);
  fs.writeFileSync(require("node:path").join(__dirname, "agent-error.json"), error.stack);
  process.stdin.resume();
});
