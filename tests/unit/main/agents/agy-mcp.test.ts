import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { nativeDeadline } from "../../../helpers/native-test-policy";
import { agyMcpFiles } from "../../../../src/main/agents/agy-mcp";
import { pluginContent } from "../../../../src/main/agents/plugin-staging";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each([false, true])(
  "stages one platform-native MCP server and credentials only as environment names: %s",
  (windows) => {
    const model = agentProvider("agy").model;
    const files = pluginContent(model, {}, windows, "/installed path").content;
    const metadata = files.find((f) => f.name === "plugin.json");
    expect(metadata?.content).toContain('"foomObserverVersion":4');
    const config = files.find((f) => f.name === "mcp_config.json");
    expect(JSON.parse(config?.content ?? "{}")).toEqual({
      mcpServers: {
        foom: {
          command: windows ? "powershell.exe" : "sh",
          args: windows
            ? [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                "/installed path/mcp.ps1",
              ]
            : ["/installed path/mcp.sh"],
        },
      },
    });
    expect(config?.content).not.toContain("FOOM_CONTROL_TOKEN");
    expect(agyMcpFiles(windows, "/installed")["mcp.ps1"]).toContain("$env:FOOM_CONTROL_TOKEN");
  },
);
it.skipIf(process.platform === "win32")(
  "is inert without valid env and execs exactly the launch-owned CLI with literal argv",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foom mcp ' $-"));
    roots.push(root);
    const files = agyMcpFiles(false, root);
    await writeFile(join(root, "mcp.sh"), files["mcp.sh"] ?? "");
    await writeFile(join(root, "foom"), '#!/bin/sh\nprintf "%s\\n" "$#" "$1" "$FOOM_SESSION"\n', {
      mode: 0o755,
    });
    const base: NodeJS.ProcessEnv = {
      FOOM_CONTROL_URL: "http://127.0.0.1:12345/control/v1",
      FOOM_CONTROL_TOKEN: "a".repeat(64),
      FOOM_SESSION: "00000000-0000-4000-8000-000000000001",
      FOOM_CLI_DIRECTORY: root,
    };
    const run = (env: NodeJS.ProcessEnv) =>
      promisify(execFile)("/bin/sh", [join(root, "mcp.sh")], {
        env: { PATH: "/not-on-path", ...env },
        timeout: 5000,
      });
    for (const key of Object.keys(base))
      expect((await run({ ...base, [key]: "" })).stdout).toBe("");
    for (const [key, value] of [
      ["FOOM_CONTROL_TOKEN", "bad"],
      ["FOOM_CONTROL_TOKEN", "g".repeat(64)],
      ["FOOM_CONTROL_URL", "https://example.com/control/v1"],
      ["FOOM_SESSION", "invalid"],
      ["FOOM_CLI_DIRECTORY", "relative"],
      ["FOOM_CLI_DIRECTORY", "/does-not-exist"],
    ])
      expect((await run({ ...base, [key ?? ""]: value })).stdout).toBe("");
    expect((await run(base)).stdout).toBe(`1\nmcp\n${base["FOOM_SESSION"] ?? ""}\n`);
  },
);

it.skipIf(process.platform !== "win32")(
  "runs the native Windows launcher with literal argv and no inherited PATH",
  { timeout: nativeDeadline(15000) },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foom mcp ' $-"));
    roots.push(root);
    await writeFile(join(root, "mcp.ps1"), agyMcpFiles(true, root)["mcp.ps1"] ?? "");
    await copyFile(process.execPath, join(root, "foom.exe"));
    await writeFile(
      join(root, "mcp"),
      "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),session:process.env.FOOM_SESSION,input})));",
    );
    const env = {
      SystemRoot: process.env["SystemRoot"],
      FOOM_CONTROL_URL: "http://127.0.0.1:12345/control/v1",
      FOOM_CONTROL_TOKEN: "a".repeat(64),
      FOOM_SESSION: "00000000-0000-4000-8000-000000000001",
      FOOM_CLI_DIRECTORY: root,
    };
    const shell = join(
      process.env["SystemRoot"] ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const run = (values: NodeJS.ProcessEnv, input?: string) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile(
          shell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(root, "mcp.ps1"),
          ],
          { env: values, cwd: root, timeout: nativeDeadline(5000) },
          (error, stdout, stderr) => {
            if (error) reject(new Error("Native MCP launcher failed", { cause: error }));
            else resolve({ stdout, stderr });
          },
        );
        if (input !== undefined) child.stdin?.end(input);
      });
    for (const key of [
      "FOOM_CONTROL_URL",
      "FOOM_CONTROL_TOKEN",
      "FOOM_SESSION",
      "FOOM_CLI_DIRECTORY",
    ])
      expect((await run({ ...env, [key]: "" })).stdout).toBe("");
    expect(JSON.parse((await run(env, '{"text":"é"}\n')).stdout)).toEqual({
      args: [],
      session: env.FOOM_SESSION,
      input: '{"text":"é"}\n',
    });
  },
);
