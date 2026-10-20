# Agent Trust

## Trust model

Config manifests load without an approval step (#539). Agents already run as the
user: anything that can write the config folder can also write shell startup files
or executables on PATH, so per-manifest approval guarded one door among many. What
keeps an agent inside its worktree is the agent's own sandbox or permission prompts.

| Boundary | Required behavior |
| --- | --- |
| Bundled manifests | Trusted as build inputs; same validator/engine/features as config. Build provenance cannot be claimed in JSON |
| Config manifest | Valid original bytes load on the scan that reads them; invalid bytes are rejected whole and never probed or launched |
| Edits/removal/restart | An edit reloads the provider; re-read before probe/preparation/spawn/action and refuse bytes changed since loading; registry revision invalidates caches. Running sessions retain immutable mapping/argv binding; removal removes the provider |
| Diagnostics | Invalid diagnostics are fixed JSON path/reason, no raw exception or secret |
| Consent distinctions | Setup actions, argument bypass, environment bypass and human orchestration grants remain separate main-owned decisions |
| Renderer and agent | Cannot write consent/health/fact fields or answer through board IPC. Validate sender top frame and exact origin/request ID in trusted window; no hook or model response is an instruction |
| Local user | Loading is not executable-content attestation or OS isolation. PATH executable may change; worktrees are not sandboxes |

Secrets and tokens never appear in templates, argv, files, renderer, logs or consent
records. Agent hook command definitions use fixed observer paths only. Observer
output cannot approve a tool. A channel's `disclosure` text is no longer shown at
load. Bundled Codex declares no disclosure and attaches notify per launch without confirmation.

### Customizing a built-in agent

Copy a bundled manifest from `src/shared/bundled-agents/` into the config folder's
`agents/` folder and give it a new root `id` and `name`; the file name must be
`<id>.json`. The copy keeps every manifest field, including hooks, setup, resume and
protections. Foom offers no Settings action for this; #424's **Duplicate as plugin**
was removed in #538.

A copy gains no trust: no profile digest, bundled observer provenance, hook observation, per-agent defaults or environment
secrets carry over. Normal config validation precedes discovery and launch; an
edit reloads it.
Codex copies use private config observer paths and their own health observations.
Antigravity copies retain the same declared setup target and ownership checks:
status is freshly inspected after loading, never copied from the built-in card.
An existing recognized lifecycle installation can be observed by the generic engine;
install/update/enable/remove still require separate trusted setup confirmation and
serialize on that same ownership target. The card switch can turn the built-in off
while the copy stays on.

## Code versus data

| Remains in Foom code | Moves into manifest data |
| --- | --- |
| Strict parser/limits, fixed operations and serializers, graph/reference validation, bounded regex | Identity, executable names, discovery facts/version floors/help flags |
| Private-file/observer ABI generation on POSIX/Windows, loopback transport and credential lifetime | Hook container templates, attachment argv, transport/response/order selection |
| Generic extractors/validators/event reducer and execution/health state machines | Field/event names, requirements, aliases, completion/fallback conditions |
| PATH resolution, argv execution, IPC validation, trust dialogs and digest storage | Argument protections, bypass matchers, status readers and offered setup action argv |
| Prompt constants, grants, per-turn reconciliation, config/child constraints, restore and checkout identity | Prompt/resume layout, merge grammar, CLI guidance selection, restore capability fact |
| Local evaluator, provider provenance, tool authorization, process audits | Detection rules, approved Foom-tool syntax and bounded paste patterns |

New per-provider enable/default/environment scopes use loaded provider IDs, including config copies of built-ins; legacy three built-in settings migrate without widening a grant. The renderer receives only validated card/status/role facts.

No operations named claude/codex/agy/copilot, no manifest-loaded modules, no
built-in-only capability bit. Adding a provider requires JSON and measurements,
not workspace/renderer branches. ABI-level observer versioning is generic code;
custom manifests can express every bundled selection. Product
privacy, context isolation, sandboxing and terminal ownership are unchanged.
