# Architecture

This describes the target design. Where the code differs today, the section says so. A PR that changes a decision here updates this file in the same PR.

## Process model

| Process | Owns | Must not |
|---|---|---|
| Main | PTYs, terminal state, git and worktrees, agent launch, the hook receiver, the evaluator, secrets | Trust anything from the renderer or from agents without validation |
| Preload (sandboxed) | A small typed bridge (`window.desktop`) | Import runtime modules beyond what the sandboxed loader allows |
| Renderer | Drawing: the board, lights, the open terminal view | Import Electron or Node APIs |

## Terminals

**Today:** `src/terminal.ts` attaches one PTY per window. It pauses the PTY when the renderer falls more than 256 KB behind.

**Target:** the main process owns every terminal. A terminal is not paused just because nothing is displaying it.

- Each terminal has an ID, a PTY, and a headless xterm instance (`@xterm/headless`) that always consumes output. It holds the screen and scrollback, so a hidden agent never stalls.
- Opening a terminal sends a serialized snapshot (`@xterm/addon-serialize`), then streams live output.
- Throttling (pause at a high-water mark, resume after the renderer confirms it drew the output) applies only while a view is attached.
- The activity meter and last-lines buffer read from the same stream.

Interface sketch, not final:

```ts
type TerminalId = string;

interface TerminalSpec {
  worktree: string; // absolute path; must be a worktree Foom manages
  command: string; // resolved executable
  args: readonly string[];
  env: Readonly<Record<string, string>>; // explicit additions; the base env is scrubbed
  cols: number;
  rows: number;
  kind: "agent" | "server" | "shell";
}

interface TerminalManager {
  create(spec: TerminalSpec): TerminalId;
  write(id: TerminalId, data: string): void;
  resize(id: TerminalId, cols: number, rows: number): void;
  kill(id: TerminalId): void;
  attach(id: TerminalId): { snapshot: string }; // view opened
  detach(id: TerminalId): void; // view hidden; output keeps flowing into headless state
  tail(id: TerminalId, lines: number): string[];
  // Events: activity (rate), quiet (debounced), exit (code)
}
```

The base environment removes `npm_*` and `ELECTRON_*` variables. When launching an agent directly, Foom resolves the user's `PATH` from their login shell, because GUI apps on macOS start with a minimal `PATH`.

## IPC contract

Every channel checks the sender (the owning window, the main frame, `app://bundle/index.html`) and validates every payload at runtime. Every message carries a terminal ID.

| Channel | Direction | Payload |
|---|---|---|
| `terminal:create` | renderer → main (invoke) | spec fields the renderer may choose → `id` |
| `terminal:attach` / `terminal:detach` | renderer → main | `id` → snapshot on attach |
| `terminal:input` | renderer → main | `id`, `data` (≤ 64 KB; chunked on code-point boundaries) |
| `terminal:resize` | renderer → main | `id`, `cols`, `rows` |
| `terminal:ack` | renderer → main | `id`, `count` (attached terminals only) |
| `terminal:data` | main → renderer | `id`, `data` (attached terminals only) |
| `terminal:activity` | main → renderer | batched `[{ id, rate }]`, about 10 per second at most |
| `terminal:state` | main → renderer | `id`, state, reason, signal, timestamp |

## Worktrees

Git runs in main through `execFile` with argument arrays, never through a shell. Branch names are validated with `git check-ref-format --branch` and may not start with `-`. Foom only creates, lists and removes worktrees under the configured root (default `~/.foom/worktrees/<repo>/<branch>`) or next to repos the user added.

## Agent signals

Foom attaches its hooks per launch and never edits the user's own config:

- Claude Code: `claude --settings <foom-settings.json>` with Stop and Notification hooks.
- Codex: `codex -c notify=[...]`.
- Antigravity: output evaluator only, until research finds a supported signal.

These mechanisms must be verified against current CLI docs before we build on them.

The hook command can't run Node from the packaged app, because the RunAsNode fuse is disabled. The receiver design therefore needs a transport that plain OS tools can reach. The current proposal: an HTTP listener bound to `127.0.0.1` on a random port, called with `curl`. Each launch gets its own `FOOM_SESSION` and `FOOM_TOKEN` environment variables, and requests without a valid token are rejected. Payloads are untrusted data.

## Evaluator pipeline

`quiet` event → agent signal received? → process facts → text patterns → model (if configured) → verdict `{ state, reason, signal, confidence }` → `terminal:state` and the verdict log.

States: `needs_input`, `done`, `failed`, `quiet_ok`, `working`.

Model calls get the last 40 lines, redacted, with a timeout. A failure falls back to rules-only and never blocks the light.

## Secrets

- API keys go through Electron `safeStorage` and are never written in plain text.
- Keys never cross into the renderer after they're entered.
- The redaction pass runs before any text leaves the machine.
