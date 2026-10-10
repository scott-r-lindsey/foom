import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookAdapter } from "../../../../src/main/agents/hook-adapters";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import type { HookSignal } from "../../../../src/shared/hooks";
import { UNREACHABLE_PROXY } from "../../../helpers/unreachable-proxy";

function run(file: string, args: string[], env: Record<string, string>, stdin: string) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    // PowerShell cold startup is additional to the adapter's three-second HTTP timeout.
    const child = spawn(file, args, {
      env: { ...process.env, ...env },
      stdio: "pipe",
      timeout: 8000,
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, output });
    });
    child.stdin.end(stdin);
  });
}

describe("OS hook adapters", () => {
  it.each(["claude", "codex"] as const)(
    "delivers %s data without executing it or returning decisions",
    async (agent) => {
      const signals: HookSignal[] = [];
      const receiver = await HookReceiver.listen((signal) => signals.push(signal));
      const launch = receiver.register("terminal", agent);
      const directory = await mkdtemp(join(tmpdir(), "foom-hooks-"));
      const platform = process.platform === "win32" ? "win32" : "posix";
      const adapter = hookAdapter(agent, platform);
      const path = join(directory, `observer${adapter.extension}`);
      // Ensure both generated variants retain distinct input transports on every OS.
      expect(hookAdapter(agent, "win32").source).toContain(
        agent === "claude" ? "[Console]::In.ReadToEnd()" : "$args[-1]",
      );
      expect(hookAdapter(agent, "posix").source).toContain("--data-binary @-");
      const text = "'\"; $(exit 99) `exit 99`\n雪 🦊 @/private/file";
      const payload = JSON.stringify(
        agent === "claude"
          ? {
              session_id: "session",
              hook_event_name: "PermissionRequest",
              tool_input: { command: text },
            }
          : {
              type: "agent-turn-complete",
              "thread-id": "thread",
              "turn-id": "turn",
              "input-messages": [text],
              "last-assistant-message": text,
            },
      );
      const command = platform === "win32" ? "powershell.exe" : "sh";
      const args =
        platform === "win32"
          ? [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              path,
            ]
          : [path];
      if (agent === "codex") args.push("configured-argument", payload);
      try {
        await writeFile(path, adapter.source, { mode: 0o600 });
        expect(
          await run(
            command,
            args,
            { ...UNREACHABLE_PROXY, ...launch.env },
            agent === "claude" ? payload : "",
          ),
        ).toEqual({
          code: 0,
          output: "",
        });
        expect(signals).toEqual([
          {
            terminalId: "terminal",
            conversationId: agent === "claude" ? "session" : "thread",
            action: agent === "claude" ? "needs_input" : "classify",
            signal: agent === "claude" ? "claude:PermissionRequest" : "codex:agent-turn-complete",
          },
        ]);
        launch.revoke();
        expect(
          await run(
            command,
            args,
            { ...UNREACHABLE_PROXY, ...launch.env },
            agent === "claude" ? payload : "",
          ),
        ).toEqual({
          code: 0,
          output: "",
        });
        await receiver.close();
        expect(
          await run(
            command,
            args,
            { ...UNREACHABLE_PROXY, ...launch.env },
            agent === "claude" ? payload : "",
          ),
        ).toEqual({
          code: 0,
          output: "",
        });
        expect(signals).toHaveLength(1);
      } finally {
        await receiver.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    // Each scenario launches three bounded native processes, including cold PowerShell.
    30000,
  );
});
