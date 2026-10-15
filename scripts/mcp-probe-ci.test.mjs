import { build } from "esbuild";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { probe, reportIssue, safeReport, versionInput } from "./mcp-probe-ci.mjs";
import { requiresDesktop } from "./ci-changes.mjs";

const green = ["claude", "codex"].map((agent) => ({
  agent,
  version: "1.2.3",
  assertion: "passed",
  passed: true,
}));
const red = [{ ...green[0], assertion: "authenticated tools/call", passed: false }, green[1]];
const context = {
  repo: { owner: "test", repo: "foom" },
  serverUrl: "https://github.com",
  runId: 42,
};
function api(issues = [], fail) {
  const calls = [];
  const method = (name) => async (args) => {
    calls.push({ ...args, action: name });
    if (name === fail) throw Object.assign(new Error("Unavailable"), { status: 503 });
  };
  return {
    calls,
    github: {
      paginate: async () => issues,
      rest: {
        issues: {
          listForRepo: () => {},
          create: method("create"),
          createComment: method("comment"),
          createLabel: method("label"),
          update: method("update"),
        },
      },
    },
  };
}
test("version pins cannot inject shell arguments, npm sources or prereleases", () => {
  for (const value of [undefined, "", "latest", "1.2.3"]) assert.ok(versionInput(value));
  for (const value of [
    "--prefix=/tmp",
    "file:/tmp",
    "1.2.3; echo secret",
    "1.2.3-beta",
    "1.2.3\n",
    "01.2.3",
    "next",
  ])
    assert.throws(() => versionInput(value));
});
test("reports reject arbitrary data rather than forwarding untrusted output", () => {
  assert.deepEqual(safeReport(green), green);
  for (const value of [
    null,
    [],
    [{ ...green[0], version: "SECRET" }, green[1]],
    [{ ...red[0], assertion: "model output" }, green[1]],
    [{ ...green[0], passed: false }, green[1]],
  ])
    assert.throws(() => safeReport(value));
  assert.deepEqual(safeReport(green.map((row) => ({ ...row, stdout: "SECRET" }))), green);
});
test("isolated installs use argument arrays, omit credentials and clean up", async () => {
  const calls = [];
  let root;
  const rows = await probe(
    {
      PATH: "/bin",
      GITHUB_TOKEN: "SECRET",
      ANTHROPIC_API_KEY: "SECRET",
      FOOM_PROBE_CLAUDE_VERSION: "1.2.3",
    },
    async (command, args, options) => {
      calls.push({ command, args });
      root = options.env.HOME;
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(options.env.FOOM_PROBE_DEBUG, undefined);
      if (args[0] === "--version")
        return {
          stdout: command.endsWith("claude") ? "1.2.3 (Claude Code)\n" : "codex-cli 1.2.3\n",
        };
      return { stdout: "PRIVATE MODEL OUTPUT" };
    },
  );
  assert.deepEqual(rows, green);
  assert.equal(calls[0].command, "pnpm");
  assert.deepEqual(calls[0].args.slice(0, 5), [
    "--dir",
    join(root, "claude"),
    "add",
    "--ignore-workspace",
    "--config.node-linker=hoisted",
  ]);
  assert.ok(calls[0].args.includes("--allow-build=@anthropic-ai/claude-code"));
  assert.ok(calls[0].args.includes("@anthropic-ai/claude-code@1.2.3"));
  assert.ok(calls[3].args.includes("--allow-build=@openai/codex"));
  assert.ok(calls[3].args.includes("@openai/codex@latest"));
  await assert.rejects(access(root));
});
test("failed assertions survive privately, both clients run, and arbitrary errors are discarded", async () => {
  const rows = await probe({ PATH: "/bin" }, async (command, args, options) => {
    if (args[0] === "--version")
      return { stdout: command.endsWith("claude") ? "1.2.3 (Claude Code)" : "codex-cli 1.2.3" };
    if (args[0] === "scripts/probe-mcp.mjs") {
      await writeFile(
        options.env.FOOM_PROBE_STATUS,
        JSON.stringify(args[1] === "claude" ? "authenticated tools/call" : "PRIVATE OUTPUT"),
      );
      throw new Error("SECRET");
    }
    return {};
  });
  assert.deepEqual(rows, [red[0], { ...green[1], assertion: "startup", passed: false }]);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|PRIVATE/);
});
test("installation and version failures produce safe failures for each client", async () => {
  const missing = await probe({}, async () => {
    throw new Error("PRIVATE");
  });
  assert.ok(
    missing.every(
      (row) => row.assertion === "installation" && row.version === "unavailable" && !row.passed,
    ),
  );
  const malformed = await probe({}, async () => ({ stdout: "1.2.3\nSECRET" }));
  assert.ok(malformed.every((row) => row.assertion === "version" && !row.passed));
});
test("first failure creates one labeled issue, subsequent failures update it and recovery comments", async () => {
  const first = api();
  await reportIssue(first.github, context, red);
  assert.deepEqual(
    first.calls.map((call) => call.action),
    ["label", "create"],
  );
  assert.deepEqual(first.calls[1].labels, ["mcp-probe"]);
  assert.match(first.calls[1].body, /claude 1.2.3: authenticated tools\/call/);
  const existing = api([{ number: 7, title: "MCP compatibility probe", state: "open" }]);
  await reportIssue(existing.github, context, red);
  await reportIssue(existing.github, context, green);
  assert.deepEqual(
    existing.calls.map((call) => call.action),
    ["comment", "comment"],
  );
  assert.match(existing.calls[1].body, /recovered/);
  const closed = api([{ number: 7, title: "MCP compatibility probe", state: "closed" }]);
  await reportIssue(closed.github, context, red);
  assert.deepEqual(
    closed.calls.map((call) => call.action),
    ["update", "comment"],
  );
});
test("green does not create an issue; API failures remain failures", async () => {
  const fresh = api();
  await reportIssue(fresh.github, context, green);
  assert.deepEqual(fresh.calls, []);
  const broken = api([], "label");
  await assert.rejects(reportIssue(broken.github, context, red));
  assert.deepEqual(
    broken.calls.map((call) => call.action),
    ["label"],
  );
});
test("nightly probe runs independently with narrowly scoped permissions and no publish dependency", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const job = workflow.split("\n  mcp-probe:\n")[1].split("\n  nightly:\n")[0];
  assert.match(
    job,
    /if: github.event_name == 'schedule' \|\| github.event_name == 'workflow_dispatch'/,
  );
  assert.doesNotMatch(job, /needs:|contents: write|secrets\.|continue-on-error|pull_request/);
  assert.match(job, /permissions:\n {6}contents: read\n {6}issues: write/);
  assert.equal(workflow.match(/issues: write/g).length, 1);
  assert.equal(workflow.match(/contents: write/g).length, 1);
  assert.match(job, /group: mcp-probe-issue\n {6}cancel-in-progress: false/);
  assert.match(job, /persist-credentials: false/);
  assert.match(workflow, /needs: \[changes, checks, unit, desktop\]/);
  assert.match(workflow, /needs: \[changes, quality\]/);
  assert.equal(requiresDesktop(["scripts/mcp-probe-ci.mjs"]), true);
  assert.equal(requiresDesktop([".github/workflows/ci.yml"]), true);
});

test("the real-CLI probe bundle resolves the current shared engine without executing clients", async () => {
  const source = await readFile(new URL("./probe-mcp.mjs", import.meta.url), "utf8");
  const contents = source.match(/contents:\s*'([^']+)'/u)?.[1];
  assert.ok(contents, "Probe must declare its fixed bundle entry point");
  const result = await build({
    stdin: { contents, resolveDir: process.cwd() },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  assert.equal(result.outputFiles.length, 1);
});
