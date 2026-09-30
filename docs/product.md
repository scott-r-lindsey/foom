# Product

Foom is a desktop workspace for running many coding agents at once, each in its own git worktree and terminal. Its job is to route your attention. Terminals stay hidden, and Foom tells you which one needs you.

The target is about 10 concurrent agents. Supported agents are Claude Code (`claude`), Codex (`codex`), and Antigravity (`agy`). Any other CLI runs as a plain terminal, watched by the evaluator.

## Terms

- **Repository**: a git repo the user has added.
- **Worktree**: a `git worktree` Foom creates for one branch. Agents never share a worktree.
- **Terminal**: one PTY session inside a worktree. It may run an agent, a dev server, or a shell.
- **Light**: the indicator that represents a hidden terminal.
- **Evaluator**: the pipeline that decides what a terminal's state is when its output stops.

## The light

The light carries two separate signals.

- **Motion is activity.** Brightness follows the terminal's real output rate. It pulses, but it never strobes: keep it under 3 Hz and respect reduced-motion settings.
- **Color is the evaluator's verdict.** It changes only when the evaluator decides something.

| State | Light | Meaning |
|---|---|---|
| Working | Brand violet, brightness follows output | Output is arriving |
| Checking | Brand violet, slow breathing | Output stopped; the evaluator is running |
| Needs you | Amber, steady, with a halo | Waiting for input or approval |
| Done | Green | Finished successfully |
| Failed | Magenta, square | Exited with an error or gave up |
| Quiet | Dim neutral | Quiet but fine (dev server, long install) |

- Done and Failed dim once the user has looked at them.
- Needs you clears only when the user replies or dismisses it. Opening the terminal doesn't clear it.
- Failed uses a square light, so the state never depends on color alone.
- Every verdict carries a one-line reason and the signal that produced it, for example `Wants to edit src/main.ts · pattern: (y/n)`.

## Revealing a terminal

1. **Glance**: the light plus its reason line.
2. **Peek**: hover or press a key to see the last lines. Focus doesn't move.
3. **Open**: the full interactive terminal. Esc hides it again.

`N` opens whichever terminal has waited longest. Rows keep a stable position so users learn where each terminal lives. The waiting queue is ordered by wait time, not by layout.

## The evaluator

Checks run from cheapest and most certain to least:

1. **Agent signals**: Claude Code hooks and Codex `notify`, attached per launch. These report specific events, not necessarily task completion; a finished response can still ask a question. See [agent research](agents.md).
2. **Process facts**: exit code, the shell prompt returning, echo changes only with corroborating prompt context (agent TUIs also disable echo during ordinary operation; this may not be detectable on Windows).
3. **Text patterns** in the tail: `(y/n)`, `Password:`, `Press Enter`.
4. **A model** for what's still ambiguous, such as a question asked in plain prose.

"Quiet" is not "done". A process can be silent while it works. The debounce adapts: it's short when the tail ends in a question and longer mid-stream.

Every verdict and the user's next action (replied, dismissed, ignored) go into a local log. Dismissing an alert counts as feedback. The log becomes the test set for improving the evaluator.

### Inference sources

The model tier uses one of these sources:

- **An agent the user already has**: a one-shot headless call through `claude -p` or `codex exec`, using the user's existing login. No key is stored. Not available yet: Foom can't yet enforce that such a call sees only the terminal tail (see [architecture](architecture.md#evaluator-pipeline)). Preflight shows it as unavailable.
- **An API key**: Anthropic, OpenAI, or Google. The key is stored with Electron `safeStorage`.
- **A local model**: any OpenAI-compatible endpoint, such as Ollama.
- **Rules only**: no model. Ambiguous terminals stay neutral.

The evaluator sends only the last 40 lines of a quiet terminal, with likely secrets redacted. It never sends files, diffs, or keystrokes.

## First run

Setup is a preflight countdown:

1. **Agents** (T-3): detect the supported CLIs on PATH and show each one's attention signal. One setting controls whether Foom attaches hooks per launch.
2. **Repositories** (T-2): pick repos and where new worktrees live. The default is `~/.foom/worktrees`.
3. **Evaluator** (T-1): pick an inference source and test it on a sample.
4. **Go / no-go** (T-0): each item shows GO or NO-GO with a link back to its step. Launch needs every item GO: at least one agent ready and one repository added.

A model source is used only after it passes Run check. Launch opens an empty board with **New worktree**. **Preflight** on the board runs setup again with the saved choices; Esc returns to the board.

## Quitting

Closing the window quits Foom on every platform, including macOS. The close button,
⌘W and ⌘Q on macOS, and Alt+F4 and Ctrl+Q elsewhere use the same quit path.
If any terminal is running, Foom asks for confirmation; Cancel keeps everything running.
Quitting stops every PTY before the app exits. Terminals live exactly as long as the app.

## Mockups

Clickable mockups live in [`docs/mockups/`](mockups/README.md): the [board](mockups/board.html), [first run](mockups/first-run.html), and [brand](mockups/brand.html). The board and first-run mockups predate the brand; take their layout and behavior, and take color and type from [brand.md](brand.md). The mockups README lists what else they get wrong.
