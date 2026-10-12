// Real Claude Code and Codex CLIs against the patched control plane and a
// scripted loopback model (#222 spike). No provider credentials, no model
// calls, temporary homes only. Usage:
//   node spikes/agent-previews/clients.mjs [claude|codex]... [--mode=print|interactive] [--read-only=true|false] [--allow] [--out=FILE]
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { startControl } from "./server.mjs";
import { startModel } from "./model.mjs";

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v = "true"] = a.slice(2).split("=");
    return [k, v];
  }),
);
const agents = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const mode = flags.mode ?? "print";
const readOnly = (flags["read-only"] ?? "true") === "true";

// The scripted "model": open a mockup, try to escape, list, then stop.
const SCRIPT = [
  { tool: "open_preview", input: { path: "docs/mockup.html" } },
  { tool: "open_preview", input: { path: "../outside/secret.md" } },
  { tool: "list_previews", input: {} },
];
const model = await startModel(SCRIPT);
const seen = model.seen;
const modelUrl = model.url;

const scratch = await mkdtemp(join(tmpdir(), "foom-agent-preview-clients-"));
const worktree = join(scratch, "worktree");
await mkdir(join(worktree, "docs"), { recursive: true });
await mkdir(join(scratch, "outside"));
await writeFile(join(worktree, "docs", "mockup.html"), "<!doctype html><title>Mockup</title><h1>Mockup</h1>");
await writeFile(join(scratch, "outside", "secret.md"), "# outside the worktree");

const control = await startControl({ readOnly });
const report = { mode, readOnly, allow: Boolean(flags.allow), runs: [] };

// Keep only what answers the question: refusals, approvals and the final text.
function summarize(agent, stdout) {
  if (agent === "claude") {
    try {
      const value = JSON.parse(stdout);
      return { result: value.result, permissionDenials: (value.permission_denials ?? []).map((d) => d.tool_name.replace(/foom_[0-9a-f]+/, "foom_…")) };
    } catch {
      return { raw: plain(stdout).slice(-600) };
    }
  }
  const events = stdout.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  return {
    events: events
      .filter((e) => /item\.(completed|started)|error|turn\.failed/.test(e.type ?? ""))
      .map((e) => JSON.stringify(e).replace(/foom_[0-9a-f]+/g, "foom_…").slice(0, 400)),
  };
}

// Strip ANSI so screens can be searched and committed as evidence.
const plain = (text) => text.replace(/\x1b\[(\d*)C/g, (_, n) => " ".repeat(Number(n || 1))).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|\r/g, "");

try {
  for (const agent of agents.length ? agents : ["claude", "codex"]) {
    model.reset();
    control.protocol.length = 0;
    const version = (await execute(agent, ["--version"])).stdout.trim();
    const home = join(scratch, `${agent}-home`);
    await mkdir(home, { recursive: true });
    const terminalId = `${agent}-${mode}`;
    const grant = control.grant(worktree, terminalId, agent === "claude" ? { agent, name: "Claude Code" } : { agent, name: "Codex" });
    const attachment = await control.control.prepareMcpLaunch(agent, control.endpoint);
    const server = agent === "claude" ? Object.keys(JSON.parse(await readFile(attachment.args[1], "utf8")).mcpServers)[0] : attachment.args[1].match(/mcp_servers\.([a-z0-9_]+)=/)[1];
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TERM: "xterm-256color",
      CODEX_HOME: home,
      CLAUDE_CONFIG_DIR: home,
      ...grant.env,
      ANTHROPIC_BASE_URL: modelUrl,
      ANTHROPIC_API_KEY: "sk-ant-synthetic-0000000000000000000000",
      OPENAI_API_KEY: "synthetic",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    };
    const prompt = "Show me the mockup you wrote.";
    const codexModel = ["-c", 'model_provider="synthetic"', "-c", `model_providers.synthetic={name="synthetic",base_url="${modelUrl}/v1",wire_api="responses"}`, "-c", 'model="synthetic"'];
    let args;
    if (agent === "claude") {
      // Pre-accept onboarding, folder trust and the synthetic key in the temporary home only.
      await writeFile(join(home, ".claude.json"), JSON.stringify({
        hasCompletedOnboarding: true,
        theme: "dark",
        customApiKeyResponses: { approved: [env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] },
        projects: { [worktree]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      }));
      args = mode === "print"
        ? ["-p", "--permission-mode", "default", "--output-format", "json", ...(flags.allow ? ["--allowedTools", `mcp__${server}__open_preview,mcp__${server}__list_previews`] : []), ...attachment.args, "--", prompt]
        : [...(flags["permission-mode"] ? ["--permission-mode", flags["permission-mode"]] : []), ...(flags.allow ? ["--allowedTools", `mcp__${server}__open_preview,mcp__${server}__list_previews`] : []), ...attachment.args, "--", prompt];
    } else {
      args = mode === "print"
        ? ["exec", "--skip-git-repo-check", "--ephemeral", "--json", ...codexModel, ...attachment.args, "--", prompt]
        : [...codexModel, ...(flags["codex-approval"] ? ["-c", `approval_policy="${flags["codex-approval"]}"`] : []), "-c", `projects.${JSON.stringify(worktree)}.trust_level="trusted"`, "--no-alt-screen", ...attachment.args, "--", prompt];
    }
    const run = { agent, version, mode, readOnly, allow: Boolean(flags.allow), permissionMode: flags["permission-mode"] ?? null, codexApproval: flags["codex-approval"] ?? null };
    if (mode === "print") {
      try {
        const pending = execute(agent, args, { env, cwd: worktree, timeout: 60000, maxBuffer: 4 << 20 });
        pending.child.stdin.end();
        const out = await pending;
        run.exit = 0;
        globalThis.lastOut = out.stdout + out.stderr;
        run.output = summarize(agent, out.stdout);
      } catch (error) {
        run.exit = error.code ?? "error";
        run.output = summarize(agent, error.stdout ?? "");
        run.stderrTail = plain(error.stderr ?? "").slice(-800);
      }
    } else {
      // Interactive TUI in a real PTY: record whether an approval prompt appears.
      const pty = require("node-pty");
      const term = pty.spawn(agent, args, { name: "xterm-256color", cols: 120, rows: 40, cwd: worktree, env });
      let screen = "";
      term.onData((d) => { screen += d; });
      const until = async (test, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (test(plain(screen))) return true;
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      };
      const prompts = [];
      // Answer up to five approval prompts with the first option, recording each.
      for (let i = 0; i < 5; i++) {
        // Some TUIs position words with cursor moves, so spaces are optional here.
        const approval = /Do\s*you\s*want\s*to\s*(proceed|allow)|Allow\s*(this|the)\s|[Aa]pprove|Always\s*allow|Allow\s*once|Run\s*the\s*tool/;
        const finished = () => /Synthetic\s*run\s*complete/.test(plain(screen).slice(-4000));
        const hit = await until((s) => approval.test(s.slice(-3000)) || finished(), 25000);
        if (!hit || finished()) break;
        const tail = plain(screen).slice(-1800);
        prompts.push(tail.split("\n").filter((l) => l.trim()).slice(-14).join("\n"));
        screen += "\n[spike: answered]\n";
        term.write("\r");
        await new Promise((r) => setTimeout(r, 1500));
      }
      run.approvalPrompts = prompts;
      run.completed = /Synthetic\s*run\s*complete/.test(plain(screen));
      run.screenTail = plain(screen).split("\n").filter((l) => l.trim()).slice(-25).join("\n");
      term.kill();
    }
    run.modelRequests = seen.requests;
    if (flags.debug) run.debug = { stdout: plain(globalThis.lastOut ?? "").slice(-2000) };
    run.toolsOffered = seen.toolsOffered;
    if (agent === "claude") run.requestTools = { names: seen.allTools, deferredMention: seen.deferredMention, waitSchema: seen.waitSchema, waitResults: seen.waitResults };
    run.toolResultsSeenByModel = seen.toolResults;
    run.mcpCalls = control.protocol.filter((p) => p.method === "tools/call").map(({ tool, arguments: a, result, error }) => ({ tool, arguments: a, ...(result ? { result } : {}), ...(error ? { error } : {}) }));
    run.previewsOpen = [...control.broker.previews.values()].map((p) => ({ path: p.path, owner: p.owner === null ? null : "agent", tile: p.tile }));
    report.runs.push(run);
    attachment.dispose();
    grant.dispose();
    control.broker.revoke({ generation: "x" });
    for (const id of [...control.broker.previews.keys()]) control.broker.humanClose(id);
    control.broker.dismissed.clear();
  }
} finally {
  await control.close();
  model.close();
  await rm(scratch, { recursive: true, force: true });
}
const json = JSON.stringify(report, null, 2).replaceAll(scratch, "<scratch>");
if (flags.out) await writeFile(flags.out, `${json}\n`);
console.log(json);
