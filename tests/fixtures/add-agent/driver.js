// Deterministic config agent exercising shipped CLI commands, never a real model.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const root = process.argv[2];
const cli = process.platform === "win32" ? "foom.exe" : "foom";
const call = (...args) => JSON.parse(execFileSync(cli, args, { encoding: "utf8" })).result;
const probe = (...args) => call("agent", "probe", ...args);
const draft = path.join(process.cwd(), "agents/workflow-agent.json");
const report = (value) => {
  const target = path.join(root, "result.json");
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(value));
  fs.renameSync(`${target}.tmp`, target);
};
try {
  const guide = fs.readFileSync("AGENTS.md", "utf8");
  for (const command of [
    "foom agent probe start",
    "--resume <conversationId>",
    "foom config test-rules",
    "foom agent probe events",
    "foom config validate .",
  ])
    assert.ok(guide.includes(command), command);
  const executable = path.join(
    root,
    "bin",
    process.platform === "win32" ? "workflow-agent.exe" : "workflow-agent",
  );
  const metadata = ["--version", "--help"].map((flag) =>
    execFileSync(executable, [flag], { encoding: "utf8" }),
  );
  const manifest = JSON.parse(fs.readFileSync("examples/agent.json", "utf8"));
  Object.assign(manifest, {
    id: "workflow-agent",
    name: "Workflow fixture",
    executables: ["workflow-agent"],
  });
  manifest.discovery = {
    version: { prefix: "v", suffixes: ["", "\n"] },
    facts: [
      { id: "hookVerified", enabled: false },
      { id: "mcpVerified", enabled: false },
    ],
  };
  manifest.launch.arguments.arguments = [path.join(root, "agent.cjs")];
  delete manifest.launch.prompt;
  manifest.conversation.newId.arguments = ["--title", "{newId}"];
  const when = {
    all: [
      { field: "control", op: "eq", value: true },
      { field: "mcpVerified", op: "eq", value: true },
    ],
  };
  manifest.launch.mcp = { arguments: [], when };
  manifest.launch.environment = [{ name: "AGENT_CONFIG", value: "{file:mcp.json}", when }];
  manifest.files = [
    {
      name: "mcp.json",
      scope: "launch",
      format: "json",
      content:
        '{"mcpServers":{{mcpName:json}:{"type":"http","url":{mcpUrl:json},"headers":{"Authorization":"Bearer ${FOOM_CONTROL_TOKEN}"}}}}',
      when,
    },
  ];
  manifest.attention.rules = [];
  const save = () => fs.writeFileSync(draft, JSON.stringify(manifest));
  save();
  execFileSync(cli, ["config", "validate", draft]);
  let id = probe("start", manifest.id, "--manifest", draft).probe;
  const waitScreen = (text) => {
    const until = Date.now() + Number(process.argv[3]);
    do {
      probe("wait", id, "--quiet", "0.1");
      if (probe("screen", id).lines.join("\n").includes(text)) return;
    } while (Date.now() < until);
    throw Error(`Missing screen: ${text}`);
  };
  waitScreen("Fixture ready");
  const captures = [];
  for (const [command, text, label] of [
    ["work", "Working on", "working"],
    ["permission", "Allow scratch", "blocked"],
    ["approve", "Task complete", "idle"],
  ]) {
    probe("send", id, command);
    waitScreen(text);
    captures.push(probe("screen", id, "--save", label));
  }
  const rejectedDone = spawnSync(cli, ["agent", "probe", "screen", id, "--save", "done"], {
    encoding: "utf8",
  });
  assert.notEqual(rejectedDone.status, 0);
  probe("stop", id);
  call("config", "status", "--json");
  // Empty rules must fail the regression suite before observed rules are installed.
  const failing = spawnSync(cli, ["config", "test-rules", manifest.id, "--json"], {
    encoding: "utf8",
  });
  assert.equal(failing.status, 1);
  manifest.attention.rules = [
    {
      id: "working",
      state: "working",
      priority: 100,
      region: "bottom",
      lines: 40,
      match: { contains: ["Working"] },
      reason: "Scratch task running",
    },
    {
      id: "permission",
      state: "blocked",
      priority: 200,
      region: "bottom",
      lines: 40,
      match: { contains: ["Allow scratch write?"] },
      reason: "Scratch approval",
    },
    {
      id: "idle",
      state: "idle",
      priority: 100,
      region: "bottom",
      lines: 40,
      match: { contains: ["Ready for input"] },
      reason: "Scratch task finished",
    },
  ];
  save();
  call("config", "status", "--json");
  execFileSync(cli, ["config", "validate", "."]);
  const rules = call("config", "test-rules", manifest.id, "--json");
  assert.equal(rules.passed, true);
  id = probe("start", manifest.id, "--manifest", draft).probe;
  waitScreen("Fixture ready");
  const states = [];
  for (const [command, text] of [
    ["work", "Working on"],
    ["permission", "Allow scratch"],
    ["approve", "Task complete"],
  ]) {
    probe("send", id, command);
    waitScreen(text);
    states.push(probe("state", id));
  }
  const events = probe("events", id);
  assert.deepEqual(events.mcp, { connected: true, listedTools: true, pinged: true });
  for (const event of ["start", "permission", "stop"])
    assert.ok(
      events.hooks.some(
        (entry) => entry.event === event && entry.caseId === event && entry.sessionMatchesNewId,
      ),
    );
  assert.ok(!JSON.stringify(events).includes("DO_NOT_RETAIN"));
  const conversationId = states[0].conversationId;
  assert.ok(conversationId);
  probe("stop", id);
  id = probe("start", manifest.id, "--manifest", draft, "--resume", conversationId).probe;
  waitScreen(`Resumed ${conversationId}`);
  const resumed = probe("state", id);
  assert.equal(resumed.conversationId, conversationId);
  probe("stop", id);
  for (const fact of manifest.discovery.facts) fact.enabled = true;
  save();
  call("config", "status", "--json");
  const finalRules = call("config", "test-rules", manifest.id, "--json");
  const validation = JSON.parse(
    execFileSync(cli, ["config", "validate", ".", "--json"], { encoding: "utf8" }),
  );
  report({ metadata, captures, rules, finalRules, states, events, resumed, validation });
  console.log("WORKFLOW_COMPLETE");
} catch (error) {
  report({
    error: error.stack,
    agentError: fs.existsSync(path.join(root, "agent-error.json"))
      ? fs.readFileSync(path.join(root, "agent-error.json"), "utf8")
      : null,
  });
  console.error(error);
}
// Keep the config session alive until the harness tears it down.
process.stdin.resume();
