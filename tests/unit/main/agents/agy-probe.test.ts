import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { agyMcpFiles } from "../../../../src/main/agents/agy-mcp";
import { prepareProbe } from "../../../../src/main/agents/probe-launch";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { CONTROL_TOOL_CLASSES } from "../../../../src/shared/control-tool-classes";

test.skipIf(process.platform === "win32")(
  "installed-style agy launcher reaches only probe MCP through foom mcp",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foom agy probe-"));
    let prepared: Awaited<ReturnType<typeof prepareProbe>> | undefined;
    try {
      const bundle = join(root, "cli.cjs");
      await build({
        entryPoints: ["src/cli/main.ts"],
        outfile: bundle,
        bundle: true,
        platform: "node",
        format: "cjs",
        define: { FOOM_VERSION: '"fixture"' },
      });
      // Literal fixture paths, with no ambient PATH or installed agent invocation.
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await writeFile(
        join(root, "foom"),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(bundle)} "$@"\n`,
        { mode: 0o700 },
      );
      const launcher = join(root, "mcp.sh");
      await writeFile(launcher, agyMcpFiles(false, root)["mcp.sh"] ?? "");
      await writeFile(
        join(root, "agy"),
        `#!/bin/sh
case "$1" in
--version) echo '1.4.2';;
--help) echo '--prompt-interactive';;
*) exec /bin/sh ${quote(launcher)};;
esac
`,
        { mode: 0o700 },
      );
      const model = agentProvider("agy").model;
      // Model an installed plugin without probing or reading the user's agent config.
      const provider = v2Provider(
        {
          ...model,
          setup: undefined,
          discovery: {
            ...model.discovery,
            facts: model.discovery.facts.map((fact) => ({ ...fact, when: undefined })),
          },
        },
        () => Promise.resolve(),
      );
      prepared = await prepareProbe(
        provider,
        { action: "start", agent: "agy" },
        root,
        { PATH: root },
        root,
      );
      expect(prepared.spec.args).toEqual([]);
      const messages = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "fixture", version: "1" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } },
        ...Object.keys(CONTROL_TOOL_CLASSES).map((name, index) => ({
          jsonrpc: "2.0",
          id: index + 4,
          method: "tools/call",
          params: { name, arguments: {} },
        })),
      ];
      const child = promisify(execFile)(prepared.spec.command, prepared.spec.args, {
        cwd: root,
        env: prepared.spec.env,
        timeout: 5000,
      });
      child.child.stdin?.end(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
      const { stdout, stderr } = await child;
      expect(stderr).toBe("");
      expect(stdout).not.toBe("");
      const replies: unknown[] = stdout
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));
      expect(replies[0]).toMatchObject({ result: { serverInfo: { name: "foom-probe" } } });
      expect(replies[1]).toMatchObject({ result: { tools: [{ name: "ping" }] } });
      expect(JSON.stringify(replies[1]).match(/"name":/gu)).toHaveLength(1);
      expect(replies[2]).toMatchObject({ result: { isError: false, content: [{ text: "pong" }] } });
      expect(replies.slice(3)).toHaveLength(Object.keys(CONTROL_TOOL_CLASSES).length);
      for (const reply of replies.slice(3))
        expect(reply).toMatchObject({
          result: { isError: true, content: [{ text: "forbidden" }] },
        });
      expect(prepared.spec.env?.["FOOM_CLI_DIRECTORY"]).toBe(root);
      expect(prepared.spec.env?.["FOOM_CONTROL_TOKEN"]).not.toBe(prepared.spec.env?.["FOOM_TOKEN"]);
      expect(prepared.spec.env?.["FOOM_SESSION"]).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u,
      );
      expect(prepared.events?.().mcp).toEqual({ connected: true, listedTools: true, pinged: true });
    } finally {
      await prepared?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
