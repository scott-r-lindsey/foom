// The same broker through the console adapter (/control/v1), for agents without
// MCP (Antigravity) or with MCP denied by policy. No CLI command is added here;
// this calls the endpoint the packaged `foom` console uses. #222 spike.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControl } from "./server.mjs";

const scratch = await mkdtemp(join(tmpdir(), "foom-agent-preview-cli-"));
const worktree = join(scratch, "worktree");
await mkdir(join(worktree, "docs"), { recursive: true });
await writeFile(join(worktree, "docs", "plan.md"), "# Plan");
const control = await startControl();
const results = [];
try {
  const agy = control.grant(worktree, "agy-1", { agent: "agy", name: "Antigravity" });
  const pairedHuman = control.service.grantCli(worktree);
  const call = async (token, method, params) => {
    const response = await fetch(control.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, instanceId: control.service.instanceId, method, params }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const token = agy.env.FOOM_CONTROL_TOKEN;
  results.push({ who: "agent (Antigravity)", method: "whoami → capabilities", ...(await call(token, "whoami", {}).then((r) => ({ status: r.status, body: r.body?.result?.capabilities ?? r.body })) ) });
  results.push({ who: "agent (Antigravity)", method: "open_preview docs/plan.md", ...(await call(token, "open_preview", { path: "docs/plan.md" })) });
  results.push({ who: "agent (Antigravity)", method: "open_preview docs/plan.md again", ...(await call(token, "open_preview", { path: "docs/plan.md" })) });
  results.push({ who: "agent (Antigravity)", method: "open_preview with a caller-supplied worktree", ...(await call(token, "open_preview", { path: "docs/plan.md", worktree: "/" })) });
  results.push({ who: "paired human CLI", method: "open_preview docs/plan.md", ...(await call(pairedHuman.token, "open_preview", { path: "docs/plan.md" })) });
  agy.dispose();
  results.push({ who: "agent after exit", method: "list_previews", ...(await call(token, "list_previews", {})) });
} finally {
  await control.close();
  await rm(scratch, { recursive: true, force: true });
}
const json = JSON.stringify(results, null, 2).replace(/pv_[0-9a-f]{32}/g, "pv_…");
const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
if (out) await writeFile(out, `${json}\n`);
console.log(json);
