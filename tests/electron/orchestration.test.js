const { test } = require("./test-shard.js");
const path = require("node:path");
const { deadline } = require("./test-policy.js");
const { boardPage, confirmationPage, launchApp } = require("./harness.js");
const { runOrchestratorScenario } = require("./orchestrator-scenario.js");

test("console pairing requires trusted approval and gives only read-only repository scope", {
  timeout: deadline(45000),
}, async (context) => {
  const { assertCliPairing } = require("./cli-checks.js");
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const profile = await app.evaluate(({ app }) => app.getPath("userData"));
  const repository = await page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  const confirmation = await confirmationPage(app);
  await assertCliPairing(
    context,
    path.join(__dirname, "../../build/console", process.platform === "win32" ? "foom.exe" : "foom"),
    profile,
    repository,
    confirmation,
  );
});

test("an agent made orchestrator reports MCP attachment independently", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "attachment");
});

test("an Antigravity orchestrator has no MCP attachment indicator", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, true, "attachment");
});

test("an agent made orchestrator manages and reviews only its own children", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "children");
});

test("an Antigravity orchestrator manages and reviews children through the packaged console", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, true, "children");
});

test("an agent made orchestrator reviews worktree cleanup and revokes with a live child", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "cleanup");
});

test("an Antigravity orchestrator reviews worktree cleanup and revokes through the packaged console", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, true, "cleanup");
});

test("a child hands off results through the CLI without terminal input and the parent pulls them", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "handoff");
});

test("an idle orchestrator waits on children without hiding real attention", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "waiting");
});

test("unread child events mark the orchestrator row and tile until human focus", {
  timeout: deadline(120_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "unread");
});

test("local orchestrators exchange board posts and the human replies and resolves in light and dark", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "board");
});
