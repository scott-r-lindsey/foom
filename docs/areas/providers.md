# Providers

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/settings.md).

## Agent provider registry and manifest approval (#407)

The heading is retained for existing links; config manifests no longer require approval.

`main/agents/providers/provider.d.ts` declares the single `AgentProvider` contract.
Claude, Codex, Antigravity, GitHub Copilot, OpenCode and Pi register through the build-locked bundled manifest loader. The bundled loader uses the same strict parser and immutable v2 engine as config providers; JSON cannot claim its origin. See [bundled delivery and compatibility](../contracts/agent-compatibility.md#bundled-manifest-delivery-434) for digest/version rules, unchanged settings/consents and observer ABI differences. The shared engine owns discovery gates, launch argv, MCP attachment, observer selection and hook payload reduction. The launch features use capability metadata rather than comparing
agent IDs. Shared built-in policy metadata is browser-safe. Main emits generic observed-health and notifier-selection facts to the renderer; config manifests cannot grant themselves build provenance. Agent identities can now be strings, but runtime IPC accepts only IDs in
main's current loaded provider registry. Config providers cannot register a
built-in ID or duplicate another provider. Built-in orchestration restore checks
remain unchanged. v2 config plugins may declare restore capability, but a grant
still requires persisted human orchestration provenance and matching repository
identity, an installed, valid provider and supported per-launch MCP.

`shared/agent-plugin-parser.ts` validates the [version 2 format](../agent-plugins.md)
from `unknown`, rejecting version 1 with the fixed migration diagnostic
`Agent manifest version 1 is no longer supported; use version 2 (see README.md)`,
any other version with `Agent manifest version must be 2 (see README.md)`,
and unknown keys at every object boundary, including capability,
script, environment and network-reference fields. Manifest rules use the shared
`boundedRegex` implementation used by built-in rules. Manifest argv uses fixed,
field-specific substitutions and argument arrays; expanded values are never parsed
again. Discovery probes are fixed and bounded. Executables use the existing PATH
resolver and platform wrapper restrictions. Foom fetches nothing for plugins.

The config service creates and watches `agents/`, resubscribing when it is replaced.
It considers at most 50 matching direct JSON filenames per directory scan. Reads
use the same contained-directory and descriptor-bounded 64 KiB policy as config
settings. Missing, unsafe or malformed manifests never enter the active registry,
so they cannot launch even discovery probes; invalid manifests appear as rejected
cards and in Settings → Foom config with fixed paths/reasons. A valid manifest enters the
registry on the scan that reads it, with no approval step (#539): agents already
run as the user, so approval guarded one door among many. Older profiles may still hold
`agents/<id>.json` entries in `themeDigests`; they are ignored.

Registry revisions invalidate both workspace and agent-service discovery caches.
Each config provider captures a main-only byte-validation callback. Discovery checks
it before probing; launch checks it before preparation and again immediately before
spawning, and rejects a replaced provider until the next scan loads the edit.
Worktrees and same-user processes remain outside an isolation guarantee. Running sessions keep their launch-bound
hook extractors after a file change. Config sessions receive no repository control
grant. Supported config-session launches receive a separate manual-only MCP
attachment with fresh per-launch credentials and exactly the `manual` tool; it
has no repository, session, worktree, preview or orchestration authority and is
revoked on exit. Config agents inherit All sessions environment settings; the
per-agent Environment editors accept bounded valid provider IDs, including config
providers, through the shared editor and persistence limits below.

The hook receiver captures the loaded mapping at registration. Fixed top-level
extractors discard all other fields, validate and pin conversation identity, and
emit only a bounded `plugin:<id>:<event>` signal plus the existing enumerated action.
Unknown events are inert. The launch supplies the same private fixed stdin/argv
adapter, loopback token and cleanup lifecycle as built-ins. Neither templates nor
hook output can request capabilities, execute code inside main or obtain secrets.
Terminal content stays in the existing local evaluator.

Session metadata marks config-agent origin. A missing or invalid provider retains
its dormant conversation row across restart; syntactic ID validation and that marker
grant no launch authority. Resume still resolves a loaded provider and revalidates
the checkout. Merged cleanup retains a recorded
agent conversation even while its provider is unavailable.

### Consolidated agent settings (#409)

Settings → Agents and preflight's Agents step share the provider-driven card view.
Discovery includes display-only provider name, badge, executable, resume support,
plugin source and declared bypass flags. Config status separately reports rejected
manifests without probing their executables.

Agent enablement, default argv and environment lists accept bounded syntactically
valid provider IDs; those values grant no discovery or launch authority. Environment
keeps at most 100 lists across provider absence, including encrypted secret values.
The same editor serves global Environment and individual cards. `agentHooks` is a
profile-only boolean map: an explicit false selects screen rules for that agent,
and the global hooks switch takes precedence. Preferences apply on future launches,
without notifier consent. Default arguments save on blur through the
existing main-owned bypass disclosure and acknowledgement.

Disabled agents remain configurable: discovery resolves their executable on PATH
without running CLI discovery or setup probes. Agents cards refresh discovery on
entry and config changes, keeping missing switches Off without saving a preference.
Enablement changes invalidate workspace discovery caches.

### Pi (#823)

Pi ships as a locked v2 manifest and appears in the shared Settings → Agents
catalog. Pi opts in to bounded active screen sampling so its continuously redrawing
spinner can establish Working. Pi 1.4.0 uses screen rules only: its CLI exposes code extensions, not
per-launch command hooks. Foom does not install extension glue. New conversations
receive a Foom-generated UUID through `--session-id`; Resume uses `--session`,
and pasted `pi --session <UUID>` commands are recognized. `--approve` and `-a`
trust project-local files and require the normal bypass disclosure.

Pi has no advertised per-launch MCP configuration interface. Its MCP commands
write global or project `.pi/mcp.json` files, which Foom never writes. Pi cannot
receive orchestration MCP roles or restore those roles. The measured file write
ran without a permission prompt; blocked detection covers the measured model
selector and OpenAI model-not-found error, not an invented file approval screen. See [measurements](../agents.md#pi-140-measurement-823).

Existing settings keep their original required keys; absent Pi settings use the
normal enabled/empty-default behavior without rewriting the profile. Pi uses the
shared provider/disclosure-bound bypass consent: a legacy `pi: true` acknowledgement,
a custom provider identity, or an identity for an older manifest cannot authorize
`--approve` or `-a`. Cancelling disclosure saves no new consent; approving a single
launch does not grant persistent Settings consent.

### Bundled OpenCode (#824)

OpenCode joins the build-locked v2 catalog and provider-driven Settings cards.
Discovery runs only the fixed help/version probes; the v2.0.32 minimum and
`--standalone`, `--session`, `--prompt` help tokens gate hooks, MCP and initial
prompts. Launch always selects a private standalone server on supported versions.
Hooks use the generated context-event module ABI, not a provider implementation or
user-supplied script. MCP config and exact tool grants are per launch. See the
[measurements and limitations](../agents.md#opencode-v2032-824).

The bundled ID `opencode` takes precedence over a former `agents/opencode.json`:
config status reports a reserved-ID rejection in Settings → Foom config, while
the bundled Agents card remains available; Foom never rewrites or deletes the file. A full renamed copy can coexist as an
ordinary config provider. Enablement, defaults and environment remain keyed by
ID, so existing `opencode` preferences apply to the bundled provider (newly reserved
defaults are discarded under the normal recovery policy). Bypass consent is bound
to the provider origin and complete manifest, including executable declarations
and bypass disclosure policy, in main-owned profile metadata. An old ID-only
acknowledgement or a config provider's acknowledgement cannot authorize a bundled
replacement, for any agent ID. Inherited bypass defaults require a trusted launch
confirmation until reviewed and saved in Settings (or through an approved config
argument change) for the current provider identity.

The build-owned former-config ID migration retains saved `providerOrigin: config`
OpenCode rows and their conversation IDs. They remain dormant and are excluded
from automatic restart and orchestrator-role restoration. An explicit Resume resolves
the bundled provider, validates the checkout, and creates fresh launch bindings;
its new session record has bundled origin. This prevents silently replacing a
previous config provider's executable/behavior or transferring its authority on
restart. Missing/invalid config copies retain their existing dormant-row rules.

### GitHub Copilot CLI (#410)

Copilot is a bundled v2 manifest (`copilot.json`), with fixed help/version discovery
and the same build digest lock as the other bundled agents. Stable 1.0.103+ with
the advertised flags enables invocation-only `--plugin-dir` lifecycle observers,
`--additional-mcp-config` loopback HTTP MCP and interactive prompts. New launches
receive a Foom-assigned UUID through `--session-id`; Resume uses `--resume`.
Settings/preflight cards come from the provider registry, including Copilot’s
default arguments, environment, hooks switch and bypass disclosure. Config-file
bypass acknowledgements use registry IDs rather than a fixed three-agent list,
so an accepted Copilot argument disclosure persists the same acknowledgement. No global
Copilot configuration is read or edited by Foom. [Measured evidence](../agents.md#github-copilot-cli-410)
records the supported screens, hook events and platform limitations.
