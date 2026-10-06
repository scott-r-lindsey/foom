# Herdr route-A research fixture

Throwaway Linux prototype for [#159](https://github.com/scott-r-lindsey/foom/issues/159).
Read [the findings](../../docs/herdr-backend.md) before treating this as an adapter.
It does not change or build Foom. No global configuration or integration install
is needed.

## Run

From the repository root, use Node 24, `npm ci`, Python 3, Bash, Git, an installed
Herdr 0.9.3, and Xvfb for automated Electron runs. The fixture uses this repo's
locked Electron, Playwright and xterm packages; it downloads no agent or model.
`FOOM_HERDR_BINARY` may select an absolute executable, otherwise it uses
`~/.local/bin/herdr`.

```sh
node spikes/herdr/run.cjs.txt research > /tmp/herdr-research.json
node spikes/herdr/run.cjs.txt sizing > /tmp/herdr-sizing.json
xvfb-run -a node spikes/herdr/run.cjs.txt verify > /tmp/herdr-verify.json
xvfb-run -a node spikes/herdr/run.cjs.txt one > /tmp/herdr-one.json
xvfb-run -a node spikes/herdr/run.cjs.txt six > /tmp/herdr-six.json
xvfb-run -a node spikes/herdr/run.cjs.txt six-vary > /tmp/herdr-six-vary.json
```

Run measurements **sequentially**, without concurrent tests/builds, and retain
stdout as JSON. Cleanup diagnostics go to stderr. The final committed runs were
sequential; earlier development trials are not included. `one` measures one
flooding pane, with echo probes on that same pane; `six` measures six workspaces,
two repeating floods, and probes on a quiet tile; `six-vary` forces actual cell
changes with numbered flood lines. Each flood is bounded to 12 seconds. `verify` exercises browser typing, paste,
mouse, scroll and resize without a performance measurement.

For an interactive prototype, only when you intend to open a window:

```sh
node spikes/herdr/run.cjs.txt demo
```

Type into its one terminal; resize the window; wheel to navigate Herdr's history;
use mouse-enabled applications to test clicks. Browser paste is wrapped into one
complete bracketed input message, which Herdr routes using the application's
actual mode. The renderer itself has no Node/Electron APIs. The local HTTP broker
is bound to loopback, validates Host/Origin and a random capability, serves only
fixed assets, and validates a small input-message set. Navigation and new windows
are blocked, and Electron has context isolation, sandboxing and no Node integration.
This HTTP transport is research scaffolding, not the proposed production IPC.

## Isolation and cleanup

Every invocation creates a fresh mode-0700 `/tmp/foom-herdr-*` directory, sets
private XDG config/state paths, writes a private Herdr configuration and a Bash
wrapper with no startup files, removes inherited `HERDR_*`/agent identity, and
passes `--session foom-spike` to **every** Herdr child. Each invocation therefore
has different sockets despite using the same session name. No command accepts a
user pane/session target. Workspaces and Git worktrees are created only in that
temporary directory. Herdr may retain metadata and its agent-proxy socket there;
these are inert after cleanup. Files are retained for inspecting the evidence.

The harness stops its own server in `finally` and on SIGINT/SIGTERM. The research
mode deliberately tests same-version handoff, stop/restart, and SIGKILL of its own
server. It never runs `herdr update`, which could enumerate other sessions.
The sizing mode attaches a synthetic PTY TUI only to that private session. It
checks `stty size` inside three independently controlled panes and detects
`SIGWINCH` using a synthetic redraw fixture, not a real agent.

If the harness itself is forcibly killed, use the **exact private directory it
printed/created**, never the user's config directory, to stop that server:

```sh
env XDG_CONFIG_HOME=/tmp/foom-herdr-EXACT \
  XDG_STATE_HOME=/tmp/foom-herdr-EXACT \
  HERDR_CONFIG_PATH=/tmp/foom-herdr-EXACT/config.toml \
  ~/.local/bin/herdr --session foom-spike server stop
```

Never use an unqualified stop, a broad process-name kill, or the inherited socket.
A stale socket path is not evidence of a live server.

## Files and exclusions

- `run.cjs.txt`: session isolation, CLI/socket protocol and lifecycle probes.
- `browser.cjs.txt` and `view.html`: Node broker, sandboxed Electron/xterm view,
  browser input verification and one/six-tile measurement.
- `fidelity.py`: bounded synthetic ANSI/mouse/paste fixture.
- `sizing.cjs.txt`, `size-probe.py`, `tui.py`: mixed-workspace PTY size assertions
  and private TUI focus/resize checks.
- `results/`: final synthetic evidence, including full per-probe timings.

The CommonJS programs deliberately use **`.cjs.txt` research-fixture suffixes**.
Node runs/requires them as CommonJS, but the repository's application lint globs
(`js/mjs/cjs/ts/tsx/mts`) do not select them. This satisfies the issue's requirement
to add only `docs/herdr-backend.md` and `spikes/herdr/`, without changing global
lint configuration. TypeScript/build inputs and coverage already include only
`src/`; Forge packages only build output and production dependencies. The fixture
HTML/Python are likewise outside app compilation, lint and coverage. No exclusions
or quality thresholds for application source were changed.

Syntax-check fixture JS explicitly through stdin (Node's `--check` filename mode
rejects the `.txt` suffix):

```sh
node --check < spikes/herdr/run.cjs.txt
node --check < spikes/herdr/browser.cjs.txt
node --check < spikes/herdr/sizing.cjs.txt
```

## Limits

The harness retains frame records for bounded experiments, uses a simple
capability-bearing local HTTP transport, and has no production reconnect policy.
A queue overflow disconnects rather than dropping ANSI deltas. It does not test
unlimited floods, slow consumers, real agent startup/resume/reflow, IME, all key
modes, real OS clipboard access, remote machines, Windows or macOS. Benchmark echo
misses on the flooding pane are recorded; a disappearing echo is not proof of
input loss. Only ASCII typing, explicit paste, wheel/history, click down/up,
resize, frame fidelity and the stated lifecycle cases were exercised.
