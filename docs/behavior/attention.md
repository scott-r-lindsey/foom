# Attention

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

## The light

The light carries two separate signals.

- **Motion is activity.** Working agents and running shells glow with output: a logarithmic level makes 200 B/s visible and reaches full strength around 4 KB/s. Brightness rises in about 120 ms and falls in about 700 ms; rate targets change no faster than 3 Hz. The light grows up to 1.3× and casts a halo in its own color. Sidebar rows also show an eight-second trace of peak output in each quarter-second window, independent of the glow’s smoothing and target hold; tile title bars have glow only. Reduced motion removes scaling and transitions and updates brightness in four steps, and the trace, once a second. Other states hold still.
  Agent and shell scales are separate: zero at 0 B/s, level 0.39 at 200 B/s, and full at 4,000 B/s. [Measurement evidence (#412)](https://github.com/scott-r-lindsey/foom/issues/412).
  Trace peaks bypass the glow envelope so short bursts survive; steady output
  still draws a steady elevated line. Reduced motion quantizes each one-second
  peak to four levels. [Fixture replay findings](../activity-trace.md) explain tile-size limits.
- **Color is execution and attention state.** Agent lifecycle signals establish Working; the evaluator classifies attention and results.

| State | Light | Meaning |
|---|---|---|
| Working | Brand violet, brightness follows output | Agent is executing |
| Needs you | Amber, steady, with a halo | Waiting for input or approval |
| Done | Green | Finished successfully |
| Failed | Magenta, square | Exited with an error or gave up |
| Quiet | Dim neutral | Quiet but fine (dev server, long install) |
| Waiting | Neutral hourglass | Idle orchestrator waiting on children |

- Done and Failed dim once the user has looked at them.
- Agent Needs you clears when supported evidence shows execution resumed, or when the user dismisses attention. Typing and terminal output alone do not prove resumed execution. Shell attention retains reply/output behavior. Opening a terminal never clears evaluator attention.
- Failed uses a square light, so the state never depends on color alone.
- A solid light means the process is running. Exited sessions have a hollow ring (square outline for Failed), green after Done, magenta after Failed and muted otherwise. Their name and badge dim, a muted `exited` follows the name, and the accessible name includes Exited.
- Every verdict carries a one-line reason and the signal that produced it, for example `Wants to edit src/main/main.ts · pattern: (y/n)`.

An idle orchestrator shows **Waiting on N** while owned children are still running
without a read handoff, or have a newer unread handoff. Each child counts once.
Reading the latest handoff settles that child even if its process remains alive;
reading an older report does not clear a newer one. Exiting without an unread report,
takeover, close, parent exit and revocation remove that child's waiting contribution.
Waiting does not count as Needs you or Working. Real questions, permission,
credential and provider prompts, and failures retain their normal state. When no
children remain pending, the parent's normal idle/done state returns. Waiting is
presentation only: no terminal input, execution or evaluator verdict is changed.

With Claude hooks attached, an idle title stops working audio but stays Quiet until
Stop confirms completion. This keeps Esc interruptions from producing a Done chime.
Permission approval resumes Working after fresh supported progress evidence; typing
or dismissing attention alone does not resume it.

## The evaluator

Checks run from cheapest and most certain to least:

1. **Agent signals**: Claude Code and trusted Codex lifecycle hooks, with Codex `notify` as the fallback, attached per launch, plus the explicitly installed Antigravity observer plugin. These report specific events, not necessarily task completion; a finished response can still ask a question. See [agent research](../agents.md).
2. **Local agent UI signals**: capture-backed terminal title and screen rules. Idle is evidence for classification, never Done by itself. Process exit remains final and permission hooks take precedence.
3. **Process facts**: exit code, the shell prompt returning, echo changes only with corroborating prompt context (agent TUIs also disable echo during ordinary operation; this may not be detectable on Windows).
4. **Text patterns** in the tail: `(y/n)`, `Password:`, `Press Enter`.

There is no model tier: local signals cover the useful verdicts without sending terminal content to a provider. Ambiguous terminals retain the neutral rules verdict.

"Quiet" is not "done". A process can be silent while it works. The debounce adapts: it's short when the tail ends in a question and longer mid-stream.

Every verdict and the user's next action (replied, dismissed, ignored) go into a local log. Dismissing an alert counts as feedback. The log becomes the test set for improving the evaluator.

## Shell status

Shell status currently follows command start and completion in Bash 4.4+: an initial
prompt is Quiet (“Shell is ready”), a command is Working, and return to the prompt is
Done or Failed according to its exit code. Editing the next command preserves that
result until execution starts. Other shells use output patterns and process exit.
The quiet debounce preserves the current state; there is no separate Checking state. Agent Working follows
lifecycle evidence, never silence or output volume. A supported turn-end signal
stops Working immediately; classification determines the result.
