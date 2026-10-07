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
