# Agent previews prototype

Throwaway prototype for [#222](https://github.com/scott-r-lindsey/foom/issues/222).
Read [the findings](../../docs/agent-previews.md) first. It is not Foom code: it is
excluded from Foom's build, lint, format and coverage, and it changes nothing under
`src/`. Every run uses temporary directories and homes, and deletes them on exit.
No run uses provider credentials or calls a real model.

It reuses the repository's `node_modules` (Electron, esbuild, node-pty) and the
#221 containment rules in [`../previews/containment.cjs`](../previews/containment.cjs).

## Run

From the repository root, with Node 24 after `npm ci`:

```sh
node --test spikes/agent-previews/broker.test.cjs

# Real CLIs, scripted loopback model. Print (non-interactive) and interactive TUI runs.
R=spikes/agent-previews/results
node spikes/agent-previews/clients.mjs claude --mode=print --out=$R/claude-print.json
node spikes/agent-previews/clients.mjs claude --mode=print --allow --out=$R/claude-print-allow.json
node spikes/agent-previews/clients.mjs claude --mode=print --allow --read-only=false --out=$R/claude-print-mutating-allow.json
node spikes/agent-previews/clients.mjs claude --mode=interactive --permission-mode=default --out=$R/claude-tui.json
node spikes/agent-previews/clients.mjs claude --mode=interactive --permission-mode=default --allow --out=$R/claude-tui-allow.json
node spikes/agent-previews/clients.mjs codex --mode=print --out=$R/codex-print.json
node spikes/agent-previews/clients.mjs codex --mode=print --read-only=false --out=$R/codex-print-mutating.json
node spikes/agent-previews/clients.mjs codex --mode=interactive --out=$R/codex-tui.json
node spikes/agent-previews/clients.mjs codex --mode=interactive --read-only=false --out=$R/codex-tui-mutating.json

# The console adapter (/control/v1) used by the foom CLI and Antigravity.
node spikes/agent-previews/fallback.mjs --out=$R/cli-fallback.json

# End to end in Electron, under a virtual display. --focus picks the focus
# strategy; --keystrokes types 300 keys with xdotool while the agent works and
# counts where they land; --grabby makes the page keep calling focus().
X='xvfb-run -a -s "-screen 0 1280x800x24"'
eval $X npx electron spikes/agent-previews/demo.mjs codex --mute-audio --focus=detached --out=$R/demo-codex.png
eval $X npx electron spikes/agent-previews/demo.mjs claude --mute-audio --focus=detached --out=$R/demo-claude.png
for f in none load focus detached; do
  eval $X npx electron spikes/agent-previews/demo.mjs codex --mute-audio --keystrokes --focus=$f --out=$R/focus-$f.png
done
eval $X npx electron spikes/agent-previews/demo.mjs codex --mute-audio --keystrokes --grabby --focus=detached --out=$R/focus-detached-grabby.png
```

Set the CLIs on `PATH` to choose versions. The committed results used Claude Code
2.1.296 and Codex 0.162.1 on Linux. The focus runs' PNGs are deleted after each
run; only their JSON is kept.

## Files

| File | Role |
|---|---|
| `broker.cjs`, `broker.test.cjs` | Preview policy: path authority, ownership, placement, limits, dismissal, revocation, audit fields |
| `server.mjs` | Bundles Foom's real `src/main/control` modules and patches in three preview tools, so both adapters reach the broker through `ControlService.call` |
| `model.mjs` | Scripted loopback model that speaks the Anthropic Messages and OpenAI Responses streams well enough to make real CLIs call tools |
| `clients.mjs` | Runs real Claude Code and Codex against the patched control plane, in print mode or an interactive PTY, and records prompts, calls and what the model saw |
| `fallback.mjs` | The same tools through `/control/v1`, for agents without MCP and for a paired human CLI |
| `demo.mjs` | Electron board: a real agent opens a mockup that lands in an isolated preview view; measures focus and keystroke capture |
| `results/` | The committed runs cited in `docs/agent-previews.md` |
