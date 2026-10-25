# Real agent detection captures

Captured 2026-10-06 on Linux using Python `pty.openpty`, a 110×32 terminal,
`TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Foom`. Raw output was
parsed with Foom's pinned headless xterm 6.0.0. JSON retains title transitions and
at most 40 bottom plain-text lines; scratch paths and account notices are redacted.
No transcript was read. Prompts here are synthetic UI probes, not user work.

- Claude Code 2.1.291: initial trust screen, idle prompt, working turn and
  AskUserQuestion form. The latter used a private HOME/config directory with a
  private copy of login/onboarding state; trust changes stayed there. Settings and
  MCP sources were disabled for the probe. Prompt: ask red or blue using
  AskUserQuestion, without inspecting files. No question answer was submitted.
- Codex 0.160.1: startup spinner/idle and an approval request for harmless
  `printf foom-capture`, using `--no-daemon --no-alt-screen -a on-request -s read-only
  -c notify=[]`. No approval was submitted. The existing notifier was disabled
  only for this probe invocation. The separate hooks-review capture passed an
  invocation-only `hooks.SessionStart` entry with command `true`; Codex requested
  hook review. No hook was trusted or executed. It validates the notifier decision,
  not a shipped detection rule.
- Antigravity 1.3.0: startup project trust dialog, without accepting trust.

Title arrays retain transitions in observation order (consecutive duplicate values
are compacted). Each `rules` array identifies rules independently exercised by the
capture. Engine tests also cover exclusions, priority conflicts and negative
screens; fabricated tests are explicitly separate from this corpus.

No real update dialog or OSC progress sequence was observed. Claude's old braille
spinner, permission/background/overlay variants and Antigravity's remaining
states have no shipping rules yet. These omissions are deliberate: do not copy
Herdr's wider heuristic set without real captures. Linux observations are not
claims of Windows/macOS or other agent-version verification.

An additional private-home Antigravity probe stopped at onboarding/data-use consent.
It did not submit a model prompt or accept the consent screen, so it supplies no
working/question evidence. No rule is shipped from that incomplete probe.

## Provider evidence (#339)

`codex-capacity.json` records only the capacity line reported from the stalled child
in #339 on 2026-10-13. The CLI version and surrounding screen/title are unknown;
this is reported evidence, not a new PTY capture. The other three provider fixtures
record Codex's upstream rendered test snapshots at commit
`f6aca7dc461d6a9e0ae12828cd04845c31dd504e`; each JSON links its exact source.
They exercise the rate-limit error, rate-limit model switch and workspace-member
usage-limit choice. Snapshot header metadata is omitted; rendered lines are retained.
These render fixtures verify known CLI states without spending provider quota or
changing user configuration. They do not establish installed-version or platform
coverage. The Electron stand-in explicitly simulates these states.

Provider rules classify attention and inspect bounded bottom regions. They do not
grant input authority; #629 permits the owning orchestrator to answer provider prompts. Their priority
is 1000: below the working spinner (1050) and Action Required title (1100), above
plain-title idle classification (100). An active title wins even if the complete
old provider screen remains visible. Permission hooks and process exit still win.

### Title evidence and recovery priority (PR #345)

The render snapshots do not capture OSC output. Title behavior below is inferred
from the same pinned Codex source, not an authenticated stall capture:

- [`turn_runtime.rs`](https://github.com/openai/codex/blob/f6aca7dc461d6a9e0ae12828cd04845c31dd504e/codex-rs/tui/src/chatwidget/turn_runtime.rs):
  `handle_non_retry_error` dispatches overload/capacity errors to
  `on_server_overloaded_error`, rate/usage errors to `on_rate_limit_error` (which
  calls `on_error`), and other terminal errors to `on_error`. These paths call
  `finalize_turn`, which finishes the turn and updates the task-running flag.
- [`status_surfaces.rs`](https://github.com/openai/codex/blob/f6aca7dc461d6a9e0ae12828cd04845c31dd504e/codex-rs/tui/src/chatwidget/status_surfaces.rs):
  `terminal_title_has_active_progress` requires MCP startup or a running task;
  with neither present, the default title loses its working spinner. The rest of
  the title is configurable, so no exact plain title is assumed.
- [`status_and_layout.rs`](https://github.com/openai/codex/blob/f6aca7dc461d6a9e0ae12828cd04845c31dd504e/codex-rs/tui/src/chatwidget/tests/status_and_layout.rs):
  `rate_limit_switch_prompt_defers_until_task_complete` verifies that the switch
  prompt stays Pending during a task and becomes Shown after it ends.
  [`rate_limits.rs`](https://github.com/openai/codex/blob/f6aca7dc461d6a9e0ae12828cd04845c31dd504e/codex-rs/tui/src/chatwidget/rate_limits.rs)
  opens a selection picker. `ListSelectionView` does not override
  [`BottomPaneView::terminal_title_requires_action`](https://github.com/openai/codex/blob/f6aca7dc461d6a9e0ae12828cd04845c31dd504e/codex-rs/tui/src/bottom_pane/bottom_pane_view.rs),
  whose default is false: this prompt has a plain title, not Action Required.
- [`protocol.rs`](https://github.com/openai/codex/blob/f6aca7dc461d6a9e0ae12828cd04845c31dd504e/codex-rs/tui/src/chatwidget/protocol.rs)
  treats `will_retry` errors separately through `on_stream_error`; they do not
  finish the turn. A spinner during automatic retry or unrelated startup remains
  working evidence. We have no capture proving a human-blocked provider stall
  with a working title, so no speculative last-content/composer discriminator is
  added. The exact title at the unknown-version capacity report in #339 remains
  unverified; configured/disabled titles and other versions remain limitations.

`synthetic/codex-*-working.json` deliberately combines the reported/rendered
provider tails with a synthetic active spinner title. These are recovery/conflict
regressions, separate from the real evidence corpus. Tests keep the provider line
inside its matching bottom region (including the final nonblank line for rate
limits), require Working with no attention, and require provider attention with
an empty or plain idle title. Action Required instead retains permission attention.

A line spoofed by a tool or model can raise attention but cannot grant any
input capability. Old messages scrolled beyond the region and incomplete rate-limit
advice are negative test cases. Claude and Antigravity have no provider fixtures
or shipped provider rules. Generic hooks and exit codes cannot distinguish these
conditions, so no speculative mappings are shipped.

OpenCode v2.0.32 (#824), Linux 2026-10-24: four short PTY sessions in a disposable
OS-temp directory, parsed with the pinned headless xterm at 120×40. The three
OpenCode JSON fixtures retain only observed matching viewport fragments from
working, question and idle screens; the model, session title and scratch path are
redacted. The file prompt requested `ready.txt` with permission first; the observed
blocker was the question tool, followed by a successful write. No edit-permission
screen is claimed. See [measurement details](../../../docs/agents.md#opencode-v2032-824).

## Copilot 1.0.103 (#410)

Hand measurements on Linux on 2026-10-24 used an OS temporary directory,
Copilot’s normal 1.0.103 launch, and harmless reply/create-file prompts. The
100×32 PTY was parsed with the pinned headless xterm. The first reply-only
measurement also used an 80×24 PTY. Fixtures retain only matching screen regions;
scratch paths, usage and unrelated history are redacted. No title/progress
sequence was observed. The permission was cancelled, and session-only folder
trust was used. No bypass flags or global config edits were used. See
[the full measurement record](../../../docs/agents.md#github-copilot-cli-410) for
the isolated plugin, MCP and assigned-ID resume checks and platform limitations.
