# Execution

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/attention.md).

`main/workspace/orchestration-commands.ts` routes terminal events and ordered evaluation to `ExecutionOwner`. `workspace-context.ts` retains shared queues and subscriptions behind the public Workspace facade.

## Agent execution

`main/agents/execution.ts` owns an independent machine per agent invocation:
`starting`, `idle`, `working`, `blocked`, `exited`. Shell command markers remain
separate. Output, keyboard input, focus and feedback never prove agent execution.
Main subscriptions and validated `agent:execution` IPC receive transitions only,
with terminal ID, launch identity, turn number, revision, from/to, source and time.
Workspace snapshots hydrate the current state; the renderer rejects older launch
or revision evidence. Resume creates a new invocation even when the terminal ID
is reused. Revoked hook capabilities cannot address that invocation.

| Agent | Working | Blocked | Idle |
| --- | --- | --- | --- |
| Claude | Per-launch UserPromptSubmit/PreToolUse observer hooks; half-circle title | PermissionRequest hook; live screen forms | Stop hook; star title |
| Codex | Trusted per-launch UserPromptSubmit/PreToolUse/PostToolUse hooks; braille spinner title | PermissionRequest hook; Action Required title | Stop hook; fallback turn-complete notify; plain title |
| Antigravity | Opt-in PreInvocation/PostToolUse observers | Screen rules | Fully idle Stop; error/step-limit Stop is failure |

Evidence precedence is: process exit; lifecycle hooks (including Codex); active permission hooks; agent-specific
blocked forms/titles; agent working titles; generic shell patterns; neutral fallback.
A blocked agent permission form wins over a simultaneous working title; Codex
provider history is weaker than a working title. Generic password,
yes/no and Enter strings do not override supported agent working evidence.

Hooks are strongest evidence. An explicit permission hook survives spinner frames
until a working hook proves progress, or user input is followed by a fresh working
title and classification finds no agent-specific permission form. Input alone and
dismissal never resume execution. A new permission hook resets that reply evidence.
Permission screen blockers beat working titles during
classification; later positive progress supersedes stale screen evidence only after
classification verifies the current screen no longer requests attention. Repeated
spinner frames can trigger this recovery while blocked. Dismissal is tracked
separately from execution against a digest of the attention signal and screen;
unchanged evaluations stay quiet. Changed attention evidence, a new permission
hook, or a lifecycle transition invalidates that dismissal. Idle
titles may end a turn started by a hook (including Claude Esc, which lacks Stop).
With Claude hooks attached, a title-only turn end stays Quiet: Stop is required
before reporting Done, including when Stop arrives after the idle title. Without
hooks, title-only completion remains heuristic. Codex 0.161+ attaches stable
lifecycle observers with trust granted only in Codex. Once startup, prompt and Stop
are observed, later launches preserve the user's notifier. Codex idle titles without
Stop stay neutral after lifecycle hooks have been observed, including Esc interrupts.
Older/unreviewed installations keep the turn-complete notify fallback.
Antigravity lifecycle hooks use the opt-in #178 plugin; Claude and Codex global configuration
is unchanged. Observer hooks emit no permission decision.

Turn end stops Working immediately, independently of asynchronous classification.
Classification checks attention and failure evidence before announcing completion;
Needs input moves execution to blocked. A first idle is readiness, never completion.
Working-to-exited is failure even with exit code zero. A newer execution revision
invalidates in-flight classification. The board overlays execution on verdicts so
silent thinking remains Working and unsupported execution stays neutral.


### Stable Codex hook health

Codex 0.161+ receives six invocation-only `-c hooks.<event>=…` definitions. Commands
point at a versioned observer installed with Foom, outside ASAR, with no per-launch
data in the definition. Credentials remain environment-only. SessionStart is health
metadata, not a turn-ending signal; prompt/tool hooks mean Working, PermissionRequest
means Blocked, and Stop permits completion classification. The receiver validates and
pins the conversation ID across lifecycle and notify formats and retains no payload
text, tool inputs or transcript paths. Observers print nothing and exit successfully;
missing credentials make them immediately inert. Transport timeout is one second.

Main migrates matching observations from the old profile `codex-hook-health.json`
into the shared private observer directory, leaving the old file unchanged and
never reading Codex state. Migration accepts only bounded nonlinked owner-checked
records and identical definition fingerprints. Windows legacy inherited profile
ACLs may include only the current user, SYSTEM and local Administrators; new health
files remain protected and current-user-only. A corrupt/stale private record cannot
restore older trusted data. A fingerprint of the six definitions invalidates cached health when the
installed observer path/version changes. Only observed startup + prompt + Stop
permits later launches to omit `notify`. A review screen or missing
prompt callbacks in the current execution turn restores the fallback for subsequent
launches. Prompt and Stop observations are scoped to execution turns: notify is
ignored only when Stop completed that same turn. An attached notify fallback can
complete later turns even when their lifecycle callbacks disappear; title-only ends
stay neutral after lifecycle hooks have been observed. Newer launches own health
updates so an older terminal cannot overwrite a newer result. Setup exposes these
observations and directs users to Codex's `/hooks`; no Foom control grants trust or
reopens review. The [probe and limitations](../agents.md#stable-codex-lifecycle-observers-181)
record real Linux timing and the outstanding Windows real-CLI probe.

Codex's behavior is supplied by the locked bundled v2 manifest and the same launch,
mapping and health engine as config plugins (#435). The build generates
stable installed observers with the existing filenames and serialized commands.
Only bundled provenance selects installed assets and the existing exact-definition
profile health file; copied config manifests use their own private stable paths
and observations. The bundled Codex notify channel has no disclosure; legacy notifier acknowledgements
are ignored. User manifests retain the generic v2 channel `disclosure` mechanism. See [bundled delivery](../contracts/agent-compatibility.md#bundled-manifest-delivery-434).


### Antigravity plugin ownership

The bundled Antigravity manifest uses generic `PluginSetup` status, ownership,
staging and fixed CLI actions. Status reads at most 64 KiB from each fixed metadata
path because `plugin list` omits version and enabled state. Unrecognized, linked or
unreadable ownership remains unavailable and cannot authorize mutation. Settings
and preflight use `agents:setup`, whose trusted dialog discloses the executable,
fixed argv, installation location, observer-only behavior, exact staged bytes and
removal route. Every action, including enable and remove, requires separate human
confirmation. Foom never writes the agent's home files directly.

The existing `agyPluginOfferAnswered` profile answer migrates to generic profile
tracking without granting installation consent. An unanswered absent installation
still offers Plugin available, and dismissal leaves the action available. The legacy
setup IPC name forwards to the same model-owned action/confirmation path; it cannot
bypass setup ownership or consent. New scans and actions use the model.
The same `agy` enable/hooks/defaults/session keys are retained.

The version-2 ordered observer ABI preserves existing root-level filenames, hook
commands and native script bytes, including relative invocation while #467 is
unresolved. Generic staging under Foom's profile adds only a definition fingerprint
to plugin metadata; the CLI alone copies it into its installation. A recognized
legacy version >=2 without a fingerprint remains installed with no reinstall.
Older versions offer Update; disabled versions offer Enable; explicit fingerprint
mismatches offer reviewed Update. Launch adds credentials only when hooks are
enabled and installed or outdated. Channel-less reports are accepted only for the
single declared compatibility channel, bound to the authenticated launch.
A private temporary per-launch counter orders background reports; it contains no
credentials and is removed with the launch binding. Observers allocate a sequence
under an exclusive local lock before starting transport. Main ignores duplicate or
older sequence numbers, including a delayed Stop from before newer progress.
A validated fully idle Stop recovers the turn identity if its working report was
overtaken, then classifies the current tail; questions and failures still win.
The observer sends fixed event and sequence headers with stdin JSON; the receiver validates them
against the Antigravity launch, pins `conversationId`, and emits only event/action,
terminal ID, validated conversation ID and enumerated Stop facts. The pinned ID
is retained as local session metadata for Resume and Copy session ID, using the
same validation and persistence as Claude and Codex. See the [probe record](../agents.md#opt-in-antigravity-lifecycle-plugin-178)
for the documented-versus-observed Stop spelling and remaining platform verification.
