// Linux-only synthetic probe. No provider credentials or user configuration are loaded.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { spawn as spawnPty } from "node-pty";
import { gitSync } from "../../tests/helpers/git.js";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.platform !== "linux") throw new Error("Probe cleanup requires Linux process groups");
const scratch = await mkdtemp(join(tmpdir(), "foom-followup-"));
const children = new Set();
const requests = [];
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) {
      res.destroy();
      return;
    }
  }
  const body = JSON.parse(raw || "{}");
  const history = JSON.stringify(body.messages ?? body.input);
  // The attached TUI can make a separate title-generation request without history.
  // Assert continuity only for conversation turns, not this auxiliary task.
  const titleRequest = body.input?.some(
    (item) =>
      item.role === "user" &&
      item.content?.some((block) =>
        block.text?.startsWith("Generate a concise, single-line task title"),
      ),
  );
  if (!titleRequest) requests.push(history);
  const text = history.includes("remember: kumquat") ? "kumquat" : "missing";
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  if (req.url.includes("messages")) {
    event("message_start", {
      message: {
        id: "msg_probe",
        type: "message",
        role: "assistant",
        content: [],
        model: "synthetic",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    event("message_stop", {});
  } else {
    const item = {
      type: "message",
      id: "msg_probe",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
      status: "completed",
    };
    event("response.created", {
      response: { id: "resp_probe", object: "response", status: "in_progress", output: [] },
    });
    event("response.output_item.added", { output_index: 0, item });
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", {
      response: {
        id: "resp_probe",
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
  }
  res.end();
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${model.address().port}`;
function start(command, args, env, cwd) {
  const child = spawn(command, args, { env, cwd, detached: true, stdio: "pipe" });
  children.add(child);
  const watchdog = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }, 45000);
  const events = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      /* Diagnostic, not an event. */
    }
  });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(watchdog);
      resolve(code);
    });
  });
  async function wait(predicate) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const index = events.findIndex(predicate);
      if (index !== -1) return events.splice(index, 1)[0];
      if (child.exitCode !== null) throw new Error(`CLI exited ${child.exitCode}: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Event deadline: ${stderr}`);
  }
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  async function stop() {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await closed;
    lines.close();
    children.delete(child);
  }
  return { send, wait, stop, child, closed, events, stderr: () => stderr };
}
const remember = "remember: kumquat";
const followup = "What word did I previously ask you to remember?";
try {
  for (const agent of ["claude", "codex"]) {
    console.log(execFileSync(agent, ["--version"], { encoding: "utf8" }).trim());
    const home = join(scratch, agent);
    const cwd = join(home, "checkout");
    await mkdir(home, { recursive: true });
    const repo = join(home, "repo");
    await mkdir(repo);
    gitSync(["init", "--quiet", "--initial-branch=main", "--template=", repo]);
    gitSync([
      "-C",
      repo,
      "-c",
      "user.name=Probe",
      "-c",
      "user.email=probe@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    gitSync(["-C", repo, "worktree", "add", "--quiet", "-b", "probe-child", cwd]);
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: home,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "synthetic",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    if (agent === "claude") {
      const args = [
        "-p",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--tools",
        "",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
      ];
      let cli = start(agent, args, env, cwd);
      const ask = async (process, content) => {
        process.send({ type: "user", message: { role: "user", content } });
        const result = await process.wait((e) => e.type === "result");
        assert.equal(result.is_error, false);
        assert.equal(result.result, "kumquat");
        return result.session_id;
      };
      const id = await ask(cli, remember);
      assert.equal(await ask(cli, followup), id);
      console.log("claude: two sequential turns share session ID and history; stdin stays open");
      // Deliberately test a second structured writer while first process is still idle.
      const beside = start(agent, [...args, "--resume", id], env, cwd);
      try {
        assert.equal(await ask(beside, followup), id);
        console.log(
          "claude: second process can resume while first remains alive (no exclusive writer guarantee)",
        );
      } finally {
        await beside.stop();
      }
      await cli.stop();
      cli = start(agent, [...args, "--resume", id], env, cwd);
      try {
        assert.equal(await ask(cli, followup), id);
      } finally {
        await cli.stop();
      }
      console.log("claude: post-exit resume preserves ID and prior prompt in same checkout");
    } else {
      const config = [
        "-c",
        'model_provider="synthetic"',
        "-c",
        `model_providers.synthetic={name="synthetic",base_url="${url}/v1",wire_api="responses"}`,
        "-c",
        'model="synthetic"',
      ];
      let cli;
      let serial = 0;
      async function rpc(method, params) {
        const id = ++serial;
        cli.send({ id, method, params });
        const response = await cli.wait((e) => e.id === id);
        assert.equal(response.error, undefined, JSON.stringify(response.error));
        return response.result;
      }
      async function init() {
        cli = start(agent, ["app-server", ...config], env, cwd);
        await rpc("initialize", { clientInfo: { name: "foom_spike", version: "0.1.0" } });
        cli.send({ method: "initialized" });
      }
      async function turn(id, text) {
        const started = await rpc("turn/start", {
          threadId: id,
          input: [{ type: "text", text, text_elements: [] }],
        });
        const completed = await cli.wait(
          (e) => e.method === "turn/completed" && e.params.turn.id === started.turn.id,
        );
        assert.equal(completed.params.turn.status, "completed");
        assert.equal(
          completed.params.turn.items.find((i) => i.type === "agentMessage")?.text,
          "kumquat",
        );
      }
      await init();
      const initial = await rpc("thread/start", {
        cwd,
        approvalPolicy: "on-request",
        sandbox: "read-only",
      });
      const id = initial.thread.id;
      assert.equal(initial.thread.cwd, cwd);
      await turn(id, remember);
      await turn(id, followup);
      console.log("codex: two app-server turns share thread ID, cwd and history");
      await cli.stop();
      await init();
      const resumed = await rpc("thread/resume", { threadId: id });
      assert.equal(resumed.thread.id, id);
      assert.equal(resumed.thread.cwd, cwd);
      await turn(id, followup);
      console.log("codex: app-server restart/resume preserves thread and checkout");
      const execArgs = ["exec", "resume", "--json", "--skip-git-repo-check", ...config, id, "-"];
      const beside = start(agent, execArgs, env, cwd);
      beside.child.stdin.end(followup);
      try {
        assert.equal(await beside.closed, 1);
        assert.match(beside.stderr(), /already has an active writer/);
        console.log("codex: exec resume beside idle app-server refused: active writer");
      } finally {
        await beside.stop();
      }
      await cli.stop();
      const exec = start(agent, execArgs, env, cwd);
      exec.child.stdin.end(followup);
      try {
        const started = await exec.wait((e) => e.type === "thread.started");
        assert.equal(started.thread_id, id);
        const item = await exec.wait(
          (e) => e.type === "item.completed" && e.item.type === "agent_message",
        );
        assert.equal(item.item.text, "kumquat");
        await exec.wait((e) => e.type === "turn.completed");
        console.log("codex: exec resume after app-server exit preserves ID and history");
      } finally {
        await exec.stop();
      }
      if (process.argv.includes("--remote-tui")) {
        const reservation = tcpServer();
        await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
        const port = reservation.address().port;
        await new Promise((resolve) => reservation.close(resolve));
        const address = `ws://127.0.0.1:${port}`;
        cli = start(agent, ["app-server", "--listen", address, ...config], env, cwd);
        let socket;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          try {
            socket = new WebSocket(address);
            await new Promise((resolve, reject) => {
              socket.addEventListener("open", resolve, { once: true });
              socket.addEventListener("error", reject, { once: true });
            });
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        assert.equal(socket?.readyState, WebSocket.OPEN);
        socket.addEventListener("message", (e) => cli.events.push(JSON.parse(e.data)));
        cli.send = (value) => socket.send(JSON.stringify(value));
        await rpc("initialize", { clientInfo: { name: "foom_spike", version: "0.1.0" } });
        cli.send({ method: "initialized" });
        await rpc("thread/resume", { threadId: id });
        const tui = spawnPty(agent, ["resume", id, "--remote", address, "--no-alt-screen"], {
          cwd,
          env,
          cols: 120,
          rows: 40,
        });
        let screen = "";
        let live = true;
        tui.onExit(() => {
          live = false;
        });
        const subscription = tui.onData((data) => {
          screen = (screen + data).slice(-65536);
        });
        try {
          const deadline = Date.now() + 15000;
          while (!screen.includes("kumquat") && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
          assert(screen.includes("kumquat"), "Remote TUI did not render prior conversation");
          assert(live, "Remote TUI exited");
          console.log("codex remote TUI: prior conversation visible");
          if (process.env.FOOM_PROBE_DEBUG) console.log(screen);
          const previousLength = screen.length;
          await turn(id, followup);
          const renderDeadline = Date.now() + 15000;
          while (!screen.slice(previousLength).includes("kumquat") && Date.now() < renderDeadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
          assert(live, "Remote TUI exited during follow-up");
          assert(
            screen.slice(previousLength).includes("kumquat"),
            "Remote TUI did not render follow-up",
          );
          console.log(
            "codex remote TUI: structured follow-up completed and rendered while TUI attached",
          );
        } finally {
          subscription.dispose();
          const exited = live ? new Promise((resolve) => tui.onExit(resolve)) : Promise.resolve();
          try {
            process.kill(-tui.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
          await exited;
          socket.close();
          await cli.stop();
        }
      }
    }
  }
  assert(requests.length >= 8);
  assert(requests.every((history) => history.includes(remember)));
  console.log(
    `PASS: ${requests.length} conversation requests retained the synthetic original prompt; no PTY input`,
  );
} finally {
  for (const child of children) {
    const exited =
      child.exitCode === null && child.signalCode === null
        ? new Promise((resolve) => child.once("close", resolve))
        : Promise.resolve();
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await exited;
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
