import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { prepareProbe } from "../../../../src/main/agents/probe-launch";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import fixture from "../../../fixtures/agent-plugins-v2/copilot.json";

test.each(["arguments", "environment"])(
  "fixture CLI posts gated hooks and connects to isolated MCP via %s with no normal-launch gate changes",
  async (attachment) => {
    const root = await mkdtemp(join(tmpdir(), "foom-probe-verification-"));
    let prepared: Awaited<ReturnType<typeof prepareProbe>> | undefined;
    try {
      // Avoid copying the entire Node binary per case: closing the copy can stall on disk I/O.
      // Windows keeps a native executable without requiring symlink privileges.
      if (process.platform === "win32") await copyFile(process.execPath, join(root, "copilot.exe"));
      else await symlink(process.execPath, join(root, "copilot"));
      const script = join(root, "fixture.cjs");
      await writeFile(
        script,
        `
const fs = require('node:fs');
(async () => {
 const expected=process.execArgv[process.execArgv.indexOf('--title')+1];
 const hook=async (event,id=expected) => {
  const response=await fetch(process.env.FOOM_HOOK_URL,{method:'POST',headers:{authorization:process.env.FOOM_TOKEN,'X-Foom-Session':process.env.FOOM_SESSION,'X-Foom-Channel':'lifecycle','content-type':'application/json'},body:JSON.stringify({session_id:id,hook_event_name:event,secret:'DO_NOT_RETAIN',object:{nested:{field:'DO_NOT_RETAIN'}}})});
  return response.status;
 };
 const statuses=[];
 for(const event of ['SessionStart','UserPromptSubmit','PermissionRequest','PostToolUse','Unknown','Stop']) statuses.push(await hook(event));
 statuses.push(await hook('PermissionRequest','foreign'));
 statuses.push(await hook('secret event\\n'));
 const mcpFile=process.env.AGENT_CONFIG ?? process.argv[process.argv.indexOf('--additional-mcp-config')+1].slice(1);
 const server=Object.values(JSON.parse(fs.readFileSync(mcpFile,'utf8')).mcpServers)[0];
 let session;
 const call=async (method,params,id=1) => fetch(server.url,{method:'POST',headers:{authorization:'Bearer '+process.env.FOOM_CONTROL_TOKEN,'content-type':'application/json',...(session?{'mcp-session-id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
 const initialized=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
 session=initialized.headers.get('mcp-session-id');
 await fetch(server.url,{method:'POST',headers:{authorization:'Bearer '+process.env.FOOM_CONTROL_TOKEN,'content-type':'application/json','mcp-session-id':session},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
 const listed=await (await call('tools/list',{})).json();
 const pong=await (await call('tools/call',{name:'ping',arguments:{}})).json();
 const refused=await (await call('tools/call',{name:'launch',arguments:{role:'orchestrator'}})).json();
 console.log(JSON.stringify({statuses,listed,pong,refused}));
})().catch(error=>{console.error(error);process.exitCode=1;});
`,
      );
      const raw = {
        ...fixture,
        discovery: {
          facts: [
            { id: "promptSupport", enabled: false },
            { id: "hookVerified", enabled: false },
            { id: "mcpVerified", enabled: false },
          ],
        },
        launch: {
          ...fixture.launch,
          arguments: { arguments: [script] },
          ...(attachment === "environment"
            ? {
                mcp: { ...fixture.launch.mcp, arguments: [] },
                environment: [
                  { name: "AGENT_CONFIG", value: "{file:mcp.json}", when: fixture.launch.mcp.when },
                ],
              }
            : {}),
        },
        conversation: {
          ...fixture.conversation,
          newId: { format: "uuid", arguments: ["--title", "{newId}"] },
        },
      };
      const provider = v2Provider(parseAgentManifest(JSON.stringify(raw)).model, () =>
        Promise.resolve(),
      );
      const normal = provider.discover("fixture", "", "");
      expect(normal.hooks).toBe(false);
      expect(normal.mcp).toBe(false);
      prepared = await prepareProbe(provider, { action: "start", agent: "copilot-fixture" }, root, {
        PATH: root,
      });
      const output = await promisify(execFile)(prepared.spec.command, prepared.spec.args, {
        env: prepared.spec.env,
        cwd: root,
      });
      const value: unknown = JSON.parse(output.stdout);
      expect(value).toMatchObject({
        statuses: [204, 204, 204, 204, 204, 204, 400, 204],
        listed: { result: { tools: [{ name: "ping" }] } },
        pong: { result: { isError: false } },
        refused: { result: { isError: true } },
      });
      const events = prepared.events?.();
      expect(events?.mcp).toEqual({ connected: true, listedTools: true, pinged: true });
      expect(events?.hooks).toHaveLength(8);
      expect(events?.hooks[0]).toMatchObject({
        event: "SessionStart",
        caseId: "SessionStart",
        sessionMatchesNewId: true,
      });
      expect(events?.hooks[4]).toMatchObject({ event: "Unknown", caseId: null });
      expect(events?.hooks[6]).toMatchObject({
        event: "PermissionRequest",
        caseId: null,
        sessionMatchesNewId: false,
      });
      expect(events?.hooks[7]).toMatchObject({ event: null, caseId: null });
      expect(JSON.stringify(events)).not.toContain("DO_NOT_RETAIN");
      expect(prepared.hook?.()?.action).toBe("classify");
      expect(prepared.spec.args.filter((arg) => arg.includes("(ping)"))).toHaveLength(1);
      expect(provider.discover("fixture", "", "")).toMatchObject({ hooks: false, mcp: false });
      if (events) events.hooks.length = 0;
      expect(prepared.events?.().hooks).toHaveLength(8);
    } finally {
      await prepared?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
