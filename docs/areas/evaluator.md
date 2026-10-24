# Evaluator

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/attention.md).

## Evaluator pipeline

`quiet` or parsed metadata event → process exit → permission hook → per-agent title/progress/screen rules → shell facts and generic text patterns → verdict `{ state, reason, signal, confidence }` → `terminal:state` and the verdict log.

States: `needs_input`, `done`, `failed`, `quiet_ok`, `working`.

**Today:** `src/main/evaluator/evaluator.ts` supplies the pure main-process `evaluateRules` classifier,
and `src/main/evaluator/verdict-log.ts` supplies `VerdictLog`. `ExecutionOwner` runs them for every terminal
the app owns, including shells: on quiet, on a hook signal, and on exit. Each
evaluation reads the last 40 host lines and runs in order per terminal, so a slow one
can't overwrite a newer verdict; a failure is logged and the next one still runs. The
result goes out on `terminal:state` and into the verdict log.

`src/main/workspace/execution-owner.ts` owns each invocation's execution machine,
completion/interruption evidence, hook health runtime, shell facts, output/input
revisions, evaluation generation, current verdict, feedback deduplication and
attention dismissal digest. Its narrow typed dependencies supply terminal launch
facts, host tails, verdict storage, orchestration notifications and presentation,
clock and lifecycle callbacks; it never receives the coordinator.
`orchestration-commands.ts` routes validated per-launch hook capabilities and
persists conversation IDs through the coordinator, and delegates
execution, evidence, input, feedback and exit classification to the owner.

`WorkspaceContext` retains the per-terminal promise queues across invocation
replacement; `orchestration-commands.ts` serializes work through `enqueue`.
The owner captures generation/output revisions when scheduling and the input
revision when evaluation begins, then checks those plus invocation identity and
closure after asynchronous classification and verdict storage. Replies, output, lifecycle transitions, replacement, removal and
shutdown therefore reject stale evidence. Resume drains the queue before resetting
the invocation; a fresh execution machine advances launch identity even when the ID
is reused. The session lifecycle owner releases config/probe/agent resources and notifies
orchestration synchronously before queued final classification and persistence;
see [exit phases](sessions.md#exit-observation-and-release-767). Child-event publications and unread-child reminder
projection continue through the same orchestration capabilities. After PTYs stop,
the coordinator closes and aborts launches, drains cleanup, clears execution subscriptions,
disposes unread reminders/watchers, forgets verdicts, releases agents and closes forge,
control and hook services before draining session writes. PTYs and headless screens
remain in the utility-process host; hidden terminals keep running.

A permission hook (`needs_input`) stays in force across later quiet evaluations.
For agents, typing records reply feedback but does not establish resumed execution;
neither typing nor dismissal overrides lifecycle evidence. Dismissal still clears the
attention indicator and reminders; it does not start Working audio. A later working hook
releases an explicit permission blocker. Opening a terminal is not a reply.
Shell reply/dismissal behavior remains separate: replies mark Working and dismissal
marks Quiet. Terminal-generated reports are filtered by `terminal-reports.ts`.
New lifecycle transitions invalidate asynchronous classifications. Host output
invalidates pending screen classifications but never establishes agent execution.

A verdict is published even if the log can't store it. It then has a null
`verdictId`: a reply still clears it without recording anything, and
`terminal:feedback` accepts null only for the terminal's current unstored verdict.

A known exit is final, including when an older permission hook arrives afterward.
For a live terminal, a matching permission hook takes precedence over an observed
shell-prompt return and text patterns. Completion hooks only request classification.
Prompt return must be supplied as a process fact, never inferred from `$` or `>` in
output. Echo-off is not an independent input. Text rules inspect only the last
nonblank line of the last 40 host-provided plain-text lines, recognize explicit
confirmation/password/Enter prompts, test-runner failure summaries, and listening
server URLs. Other quiet tails remain `working` with low confidence. Historical
prompts followed by more output do not request attention.

`VerdictLog.evaluate` (or `classify` then `commit`) appends a timestamped verdict with a unique ID and terminal ID
to `verdicts.jsonl` in the supplied user-data directory. `recordAction` records the
next explicit `replied`, `dismissed`, or `ignored` action against that verdict ID;
dismissal includes `not_attention` feedback. Opening a view is not an action.
Writes are serialized and synced before resolving, and new files have mode 0600.
Failures reject and can be retried. The log contains fixed rule reasons and metadata,
never tails, agent payloads, or keystrokes. The integration must handle write errors
without blocking terminal operation. One service instance owns the file; feedback
can address only verdicts issued by that instance, and historical records remain
available on disk across restart. Only the latest committed verdict per terminal
accepts feedback; superseded and removed terminals’ entries are released. ExecutionOwner
keeps the current verdict and ID when classification repeats its state and signal,
while failed writes remain retryable. No automatic
inference of ignored actions or log retention policy is implemented yet. The reusable fixture suite in
`tests/fixtures/evaluator.ts` contains sanitized, representative terminal tails.

The quiet debounce does not publish an intermediate state. Ambiguous input immediately
returns the existing neutral rules verdict. No production classifier calls a model provider.
Control API and MCP responses never send `checking`; clients may retain that deprecated
value in existing schemas for compatibility.

### Agent title, progress and screen evidence

The evaluator order is **process exit → permission hook → per-agent rules → shell
facts/generic text rules**. Main chooses the agent from its launch record;
output cannot choose a rule manifest. Shell sessions never use agent rules.
Bundled v2 manifests and the remaining `main/evaluator/agent-rules/*.json` files record
minimum engine version, provenance, ordered priorities, region, matchers, exclusions
and the source rationale. Herdr-derived rules are a capture-backed subset; the
Apache-2.0 license and modification notice are included in generated third-party
notices, accessible through [About → Third-party notices](../behavior/menus.md#application-menu-and-attention-badge).

The headless host listens to OSC 0/2 titles and parses OSC 9;4 progress without a
view. It retains only sanitized titles (512 code units, no control/format chars)
and bounded numeric progress. Changed metadata is emitted after queued parsing
finishes, with a terminal ID. Main validates it, checks live session ownership and
keeps it outside renderer IPC. Title changes request immediate evaluation only when
the detected rule or state changes. Spinner and blinking frames retain the latest
evidence without evaluating; progress-only or unknown changes wait for normal quiet
events, so they cannot trigger classification during streaming output. Existing generation/output guards discard stale results, exits stay
final. Permission hooks persist until a working hook, or a reply followed by fresh
working title evidence and no matching agent permission form; dismissal only hides attention.

Screen matching uses the existing 40-line host tail, capped to 500 characters per
line, and only the bottom nonempty lines or text after the last horizontal divider.
Titles and progress are separate local evidence. Pattern strings have a 128-character
limit; the regex subset forbids groups, repetition, alternation and backreferences.
Only fixed-width atoms, classes, anchors and approved escapes are accepted. A five
millisecond evaluation budget supplements those bounds; it is not presented as a
way to interrupt a running JavaScript regex. No matcher can type into a terminal.

Codex provider capacity/rate-limit/model-switch rules produce `provider`
attention and fixed `provider_unavailable` control metadata; see
[the adapter limits](../contracts/control-identity.md#provider-stalls-339). They classify attention; child input authority comes from the orchestrator grant and ownership. Codex provider history rules sit below working and
Action Required titles, so a resumed turn wins over a still-visible provider line.
Working and blocked rules produce fixed reasons and `rules:<agent>:<rule-id>` signals.
Idle evidence has low confidence and continues through generic rules,
never directly to Done. ExecutionOwner promotes an ambiguous result to Done
only after a recorded working-to-idle transition; Claude with hooks additionally
requires Stop, so title-only interrupts stay neutral. Initial readiness stays neutral. All rules run locally; no terminal content is sent to a model.

## Capture and metadata gates

Every bundled detection rule must match a redacted real capture in `tests/fixtures/agent-detection/`; fake Electron CLIs do not establish real UI behavior. Captures do not establish cross-platform or cross-version reliability. Uncaptured variants remain generic/neutral. Keep uncertain events neutral rather than treating missing callbacks as success.

The host accepts OSC 9;4 states 0–4 and optional integer values 0–100; state 0 means no progress/busy indication. Invalid sequences preserve prior metadata. No progress-only rule ships without capture evidence. Rules are packaged JSON and are never downloaded or supplied by a CLI. [Evidence: #161](https://github.com/scott-r-lindsey/foom/issues/161).

Claude and Antigravity have no verified provider-specific capacity/rate-limit mapping; lifecycle completion/error and generic exits cannot distinguish these causes. Support requires recorded evidence or a verified structured signal. [Evidence: #339](https://github.com/scott-r-lindsey/foom/issues/339).

The live detector and saved-capture replay share `shared/providers/screen-rules.ts` (`evaluateScreenRules` and `ruleRegion`), including priorities, exclusions and evaluation budget. Replay reports raw rule state; idle is not Done. See [capture regression rules](../contracts/agent-report.md#saved-screen-rule-regressions-592).
