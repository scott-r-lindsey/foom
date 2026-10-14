import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
export const assertions = [
  "installation",
  "version",
  "startup",
  "client execution",
  "authenticated initialize",
  "authenticated tools/list",
  "authenticated tools/call",
  "existing-server coexistence",
  "configuration preservation",
  "authenticated tool call",
  "managed-policy execution",
  "managed-policy refusal",
  "managed-policy existing-server refusal",
  "cleanup",
  "passed",
];
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function stableVersion(value) {
  return typeof value === "string" && value.trim() === value && stable.test(value);
}
export function versionInput(value) {
  if (value === undefined || value === "" || value === "latest") return "latest";
  if (!stableVersion(value)) throw new Error("Version must be latest or a stable x.y.z release");
  return value;
}
export function safeReport(value) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Invalid probe report");
  return ["claude", "codex"].map((agent, index) => {
    const row = value[index];
    if (
      row?.agent !== agent ||
      !(row.version === "unavailable" || stableVersion(row.version)) ||
      !assertions.includes(row.assertion) ||
      typeof row.passed !== "boolean" ||
      row.passed !== (row.assertion === "passed")
    )
      throw new Error("Invalid probe report");
    return { agent, version: row.version, assertion: row.assertion, passed: row.passed };
  });
}

export async function probe(env = process.env, run = execute) {
  const pins = [
    versionInput(env.FOOM_PROBE_CLAUDE_VERSION),
    versionInput(env.FOOM_PROBE_CODEX_VERSION),
  ];
  const root = await mkdtemp(join(tmpdir(), "foom-probe-ci-"));
  const rows = [];
  try {
    for (const [index, agent] of ["claude", "codex"].entries()) {
      const row = { agent, version: "unavailable", assertion: "installation", passed: false };
      rows.push(row);
      const prefix = join(root, agent);
      await mkdir(prefix);
      const status = join(root, `${agent}.json`);
      const pkg = agent === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex";
      try {
        // No shell interpolation, global installation, provider credentials or Actions token.
        const childEnv = { PATH: env.PATH, HOME: root };
        await run(
          "pnpm",
          [
            "--dir",
            prefix,
            "add",
            "--ignore-workspace",
            "--config.node-linker=hoisted",
            `--allow-build=${pkg}`,
            `${pkg}@${pins[index]}`,
          ],
          { env: childEnv, timeout: 180000, maxBuffer: 1024 * 1024 },
        );
        row.assertion = "version";
        const executable = join(prefix, "node_modules", ".bin", agent);
        const result = await run(executable, ["--version"], { env: childEnv, timeout: 15000 });
        const match = (
          agent === "claude" ? /^(\d+\.\d+\.\d+) \(Claude Code\)$/ : /^codex-cli (\d+\.\d+\.\d+)$/
        ).exec(result.stdout.trim());
        if (!match || !stableVersion(match[1])) throw new Error("Unrecognized version");
        row.version = match[1];
        row.assertion = "startup";
        await run(process.execPath, ["scripts/probe-mcp.mjs", agent], {
          env: {
            ...childEnv,
            [`FOOM_${agent.toUpperCase()}_EXECUTABLE`]: executable,
            FOOM_PROBE_STATUS: status,
          },
          timeout: 150000,
          maxBuffer: 1024 * 1024,
        });
        row.passed = true;
        row.assertion = "passed";
      } catch {
        // Never forward exceptions, stdout, stderr, model data or arbitrary assertion text.
        try {
          const phase = JSON.parse(await readFile(status, "utf8"));
          if (assertions.includes(phase) && phase !== "passed") row.assertion = phase;
        } catch {
          /* A setup failure may have no phase file. */
        }
      }
      console.log(`${agent} ${row.version}: ${row.assertion}`);
    }
    return safeReport(rows);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function reportIssue(github, context, report) {
  const rows = safeReport(report);
  const failed = rows.some((row) => !row.passed);
  const { owner, repo } = context.repo;
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    labels: "mcp-probe",
    per_page: 100,
  });
  const existing = issues.find(
    (issue) => !issue.pull_request && issue.title === "MCP compatibility probe",
  );
  if (!failed && !existing) return;
  const body = [
    failed
      ? "MCP compatibility probe failed."
      : "MCP compatibility probe recovered: all assertions passed.",
    "",
    ...rows.map((row) => `- ${row.agent} ${row.version}: ${row.assertion}`),
    "",
    `Run: ${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
  ].join("\n");
  if (existing) {
    if (failed && existing.state === "closed")
      await github.rest.issues.update({
        owner,
        repo,
        issue_number: existing.number,
        state: "open",
      });
    await github.rest.issues.createComment({ owner, repo, issue_number: existing.number, body });
  } else {
    try {
      await github.rest.issues.createLabel({
        owner,
        repo,
        name: "mcp-probe",
        color: "7057ff",
        description: "Real CLI MCP compatibility",
      });
    } catch (error) {
      if (error.status !== 422) throw error;
    }
    await github.rest.issues.create({
      owner,
      repo,
      title: "MCP compatibility probe",
      labels: ["mcp-probe"],
      body,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await probe();
  await writeFile(process.env.FOOM_PROBE_REPORT, JSON.stringify(report));
  if (report.some((row) => !row.passed)) process.exitCode = 1;
}
