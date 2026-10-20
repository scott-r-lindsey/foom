# Agent Hooks

### Payload mapping, execution and health

| Mapping field | Type / limits |
| --- | --- |
| session | Required Selector for validated conversation ID |
| event | Required Selector for event name string <=64 |
| sequence? | Selector; required positive integer decimal header 1–2147483647; duplicate/older drop before transition |
| dedupe? | Selector; identifier 1–200 [A-Za-z0-9_-], cache max 128 FIFO |
| cases | Required 1–32 ordered EventCase records |
| EventCase | `{id,event,when?,require?,action,facts?,endsTurn?,recoverTurn?}`; local case ID [A-Za-z][A-Za-z0-9_-]* <=40, event Text <=64, Condition, <=16 Requirements, action ready/working/needs_input/classify/failed; facts <=8 named normalized extractors; endsTurn boolean default true only for classify/failed, recoverTurn boolean default false and allowed only for classify with validated model-stop/fully-idle facts |
| Requirement | `{field,type,values?}`; Selector, type string/boolean/identifier/conversation/integer; string 1–200, integer safe nonnegative, enum values <=16 primitives |
| Normalized fact | `{name,field,aliases?}`; name terminationReason or fullyIdle, Selector; aliases <=8 literal key-to-primitive mappings |

Transport channel is bound by Foom, not chosen by payload. Header names are only
X-Foom-Event and X-Foom-Sequence. Mapping validation happens before any pin/cache
mutation; require fields for an event are validated even when a conditional case
is not selected. Cases for the same event must share requirements. Unknown string
events are inert; malformed fields are rejected. `classify` never means success. endsTurn=false evaluates the current tail without ending execution (Claude idle_prompt); recoverTurn=true recovers an overtaken working report before ending the turn (agy fully idle Stop).
Only classify/failed actions may set endsTurn=true; recovery must end the turn.
It requires a fullyIdle=true all-test and validated terminationReason values;
each non-model-stop value must be excluded by the case's all-tests or consumed by
an earlier failed case with a single reason eq/in all-test. Cases sharing an event
must carry identical ordered requirement arrays.
All channels share one conversation pin; first accepted recognized event establishes
it, subsequent differences reject. IDs are 1–200 ASCII letters/digits/_/-, first
letter/digit. Manual resume preserves first-event pinning (agy may silently start
over); pasted/assigned IDs require equality before accepting events. Drafts encode
this through requested-on-paste plus newId. Resume/new conversation changes saved
ID only after spawn success; normal first-event fallback may then replace it.

Channel transport is passed by the fixed observer, not inferred by payload fields. An argv-last observer emits its launch-bound channel ID; stdin observers likewise identify their configured channel.

Only reduced action/event, validated IDs and enumerated Stop facts leave the
receiver. Discard source payload immediately, never log prompts, transcript paths,
inputs/outputs or arbitrary field values. Keep existing 64 KiB body, 8 KiB header,
32-connection, 5 s receive limits, literal loopback/Host checks, no Origin, token
constant-time comparison, revoke-on-exit and terminal binding. A manifest
cannot override these limits or grant permissions through hooks.

conversation.newId arguments are inserted at the arguments stage before other manifest arguments, on new launches only; assign/persist the UUID after successful spawn and pin hook identity against it.

`execution.completion:attached` requires a completion channel when hooks attached;
`observed` begins requiring lifecycle completion after lifecycle evidence is seen.
An idle title can stop Working but cannot announce Done while completion is
required. Initial idle/ready is not completion, interruption with no Stop stays
neutral. Process exit wins; failed Stop stays failure; explicit permission survives
until progress or the existing reply+fresh-title+cleared-screen test. agy fully idle
Stop can recover an overtaken working report. Generic state/turn reconciliation
keeps the existing behavior; no rule receives terminal input capability.
`providerRules` mark provider_unavailable provenance. They classify attention without
authorizing input; the granted owning orchestrator may answer provider prompts (#629).

Health tracks observed event case IDs. Only startup + prompt + completion in a
valid execution turn establishes trusted-observed health. Startup on the health channel is consumed as metadata without changing execution readiness (current Codex behavior); ready on an ordinary channel sets idle. Review examines the raw last 20 physical lines case-sensitively in the Codex draft, separate from attention rules so it cannot mask a working title. Persist a definition
fingerprint and not-reviewed/trusted/declined/outdated state privately per provider;
latest launch owns writes. Changed definitions/path/ABI => outdated; missing/corrupt
state => not-reviewed. No trust-store read or grant. Missing prompt callbacks after
an observed turn => declined/unavailable and later launch fallback. A review text match sets outdated from trusted/outdated, otherwise not-reviewed, preserving current code; it does not mean the user declined. No timer while input box idle. Snapshot fallback at launch: establishing
launch keeps notify. Completion groups deduplicate notify after Stop for the same
execution turn; an attached notify can complete a later turn lacking lifecycle.
