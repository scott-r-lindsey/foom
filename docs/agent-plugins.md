# Agent plugin format v2 (#423)

Status: parser implemented by #430 and the generic config launch engine by #431,
2026-10-14. v2 config plugins support discovery, launch, private MCP files,
prompts, Foom tool grants, argument/environment bypass disclosure, resume and local
attention rules. Hook channels, private hook files, payload mapping and observed health are implemented
by #432. Setup status, fixed plugin actions and private staging are implemented by #433.
Setup staging materializes Foom-generated hook observers referenced by plugin-scope files (#464).
Claude Code (#434), Codex (#435) and Antigravity (#436) ship as bundled v2 manifests. Parsing alone grants no capability.
[Issue #423](https://github.com/scott-r-lindsey/foom/issues/423) established the
reviewed specification; [agent cards #409](https://github.com/scott-r-lindsey/foom/issues/409)
is now closed.

Read with [agent measurements](agents.md), [architecture](architecture.md), and
[orchestration](orchestration.md). The
[#410 decision](https://github.com/scott-r-lindsey/foom/issues/410#issuecomment-6175139041)
puts Copilot on hold for v2. [#424](https://github.com/scott-r-lindsey/foom/issues/424)
requires a config copy of a built-in to carry every behavior. Bundled and config
manifests use exactly the same engine. There are no privileged manifest capability
names, agent-ID switches, executable modules, or automatic manifest downloads.

## Forge kind (#520 / #521)

[Forge manifests](forge-plugins.md) adds `kind: "forge", version: 1` to the same
plugin system. `shared/plugin-parser.ts` dispatches before kind-specific validation;
agents accept only version 2. The config scanner now uses this dispatcher for `agents/` and `forges/`, rejects
wrong-kind files and applies its existing contained-directory, bounded-read and
watcher rules to both. Each kind has its own 50-file cap and ID namespace.

The first #521 stage implements offline forge validation, a build-locked GitHub
manifest and a transport-injected interpreter with parity tests. The second stage
adds a declarative dynamic batch plan with the same parser and interpreter for
bundled/config copies; it keeps all-check board counts separate from required-only
conclusions. It grants no CLI,
host assignment or enablement capability. Settings cards and active-provider migration remain for the integration stage. The current
no-approval/no-Duplicate agent workflow also applies to that future forge wiring.

## Behavior inventory and representation

This inventory describes code at `844ea9f`, not new measurements. Primary sources:
`src/shared/agent-plugin-parser.ts`, `agent-manifest-v2.d.ts`, `providers/{catalog,arguments}.ts`,
`src/main/agents/providers/*.ts`, `src/main/agents/*.ts`,
`src/main/config/service.ts`, `src/renderer/board/resume-field.ts`, and workspace
execution/health integration. The v2 fixture is `tests/fixtures/agent-plugin.json`.

| Current behavior | v2 data | Generic engine responsibility |
| --- | --- | --- |
| Resolve claude/codex/agy on login PATH; fixed help/version, 5 s, 256 KiB; ignore relative PATH entries and Windows wrappers | `executables`, `discovery` | Resolve and probe only loaded providers; keep full version; fail capability facts closed |
| Claude hooks: stable >=2.1.284 plus complete --settings; Codex notify >=0.155.1 plus -c; lifecycle >=0.161.0 (currently version-only) | Version grammar and help-token predicates | Numeric stable-version comparison with no upper bound; no manifest regex for version extraction |
| Claude MCP >=2.1.293 + --mcp-config; Codex MCP >=0.161.0 + -c; agy has no verified per-launch MCP | `discovery.facts`, conditional launch blocks | MCP fact independent of hooks; policy denial is not permission to weaken client settings |
| Codex --no-alt-screen only if complete flag advertised | `inline` fact, display block | Display independent of hook toggle |
| agy --prompt-interactive help gate | `guidance` fact, prompt and guidance policy | Refuse child prompt when unsupported; ordinary launch still works |
| Claude inline --settings JSON: UserPromptSubmit, PreToolUse, Stop, PermissionRequest, Notification | `hooks.channels`, `files`, attachment argv | Write equivalent private settings JSON, pass --settings file (documented file-or-JSON interface); no global settings writes |
| Codex six -c hooks.Event definitions with timeout=3, stable installed command and environment-only credentials | Stable observer placement and six attachment pairs | Keep definition stable across launches; credentials, temp files and ports excluded from trust fingerprint |
| Codex notify is JSON argv, last argument carries JSON | `notify` channel, attachment block | Fixed argv observer; attaches per launch without warning or confirmation |
| Codex replaces notifier until startup + prompt + Stop observed; establishing launch retains notify; duplicates after Stop do not reclassify same turn | `health`, completion groups, `when` predicates | Per-turn deduplication, launch snapshot, latest-launch health writes, private persistence; no startup-idle timer |
| Codex /hooks review and trusted/declined/not-reviewed/outdated health | Instruction setup action; observed-health requirements and review rules | Never type /hooks, bypass trust, read/write trust DB or infer trust from time; changed definitions invalidate observation |
| agy opt-in plugin install/update/uninstall/enable, serialized 5 s/64 KiB commands | Plugin files, setup status and fixed actions | Trusted disclosure, state/identity recheck, CLI-owned mutations only; no direct ~/.gemini writes |
| agy plugin list omits version/enabled; fixed JSON reads distinguish installed/outdated/disabled/unavailable and protect unknown foom | Fixed metadata readers and ownership predicates | Bounded no-link reads, missing vs malformed distinction; refuse unrecognized replacement/removal |
| agy observers return {} before bounded stdin; detached 1 s transport; local ordering counter; inert outside Foom | Observer response/delivery/sequence options | Foom supplies implementation on each OS, allocates sequence before detaching, redirects handles; no plugin-authored scripts |
| Reserved defaults: -- terminator and --no-alt-screen for every provider; Claude settings/safe-mode/bare and session selectors; Codex notify/hooks key paths, hook-trust bypass, resume/fork/last; agy conversation/continue/-c | `reservedArguments` plus engine-wide invariants | Validate defaults before launch; drop only invalid provider list on load; save rejects whole invalid patch |
| Bypass: direct flags; Claude permission-mode bypassPermissions; Codex sandbox/-s danger-full-access and nested sandbox_mode overrides | `bypassArguments` structured matchers | Conservative OR across all argv; later flags never cancel disclosure; --allow-dangerously-skip-permissions alone is not bypass |
| Environment bypass disclosure | `bypassEnvironment` | Inspect final layered environment in main; confirmation and neutral ◇ Bypass label; never expose secret values |
| Claude notifications permission_prompt / idle_prompt only; unknown events inert | Ordered event cases and required extractors | No prompt, tool-input, output or transcript retention |
| Codex lifecycle validates source, turn_id, tool_name, stop_hook_active; notify validates turn-id and caches 128 completed IDs | Mapping validation, dedupe, event predicates | Authenticate first; validate before pinning, bounded cache, same conversation pin across channels |
| agy validates event header, positive sequence <=2147483647, conversationId, Stop reason + fullyIdle; NO_TOOL_CALL aliases model_stop | Header extractors, sequence, aliases, ordered Stop cases | Old/duplicate reports inert; error/step-limit failed, background work working, fully idle classify |
| Resume argv: Claude --resume ID; Codex resume ID; agy --conversation ID; fresh hooks/current defaults; preserve terminal/checkout | `launch.resume`, `conversation` | Validate identity, launch serialization, revoke old invocation; CLI owns retention, never read transcripts |
| Bare IDs and literal three-word pasted commands: claude --resume/-r, codex resume, agy --conversation; no shell parsing | `resumePaste` bounded token patterns | Parse locally; IPC carries only agent + validated ID; main revalidates against loaded provider |
| First valid hook ID pins launch; manual agy resume can start a new conversation; pasted IDs pin against supplied ID | `conversation.resumePin` | Preserve manual first-event behavior; paste strict binding; reject later ID mismatch |
| Config greeting fixed main-owned text; resume has no greeting; agy merges user interactive prompts | Prompt/guidance merge policy | No repository grant for config sessions; fixed greeting and provenance remain Foom text |
| Children use no user defaults; fixed provenance prefix; Claude/Codex -- prompt last, agy interactive prompt; CLI guidance covers later human role change | Prompt policy, guidance fact | Validate <=16 KiB prompt; role grants, child limits, fresh credentials and PATH stay in main |
| Claude MCP merges variadic/comma-separated allowedTools/allowed-tools including equals forms, preserving separators inside parentheses; every tool on Foom’s own per-launch server pre-approved | `toolPermissions` merge grammar and names | Deduplicate without widening roles; deny/managed policy still wins; no grants without MCP |
| Restore orchestrator currently verified only for Claude/Codex; agy false | `conversation.restoreControl` | Human-origin persisted role + repo identity checks; ordinary resume separate; manifest fact never grants a role |
| Rules, provider stalls, readiness/completion distinction | `attention.rules`, `execution` | Exit/hook/blocker precedence, local classification, classification never writes input; a granted owning orchestrator may answer provider prompts (#629) |

## Evidence baseline

| Agent | Recorded evidence retained from agents.md | Limits for this proposal |
| --- | --- | --- |
| Claude Code | 2.1.284 Stop capture; Notification not observed in brief synthetic turn. 2.1.291 title/question/trust captures; 2.1.293 MCP floor | PermissionRequest/notification mapping partly contract-based; no new approval timing, policy, macOS or Windows measurement |
| Codex | 0.155.1 argv notify completion; 0.160.1 title/approval and hook review discovery; 0.161.0 isolated Linux /hooks trust, first-prompt SessionStart, tool/permission/Stop, resume and declined-hook fallback | Esc produced no Stop. Definition/timeout changes invalidate trust; changing script content alone did not. Native CI tests transport, not real Windows trust/TUI timing |
| Antigravity | 1.3.1 isolated plugin install/remove/disable and synthetic PreInvocation/Stop; detached observer sequence 1/2; NO_TOOL_CALL + fullyIdle. 1.3.3 resume kept UUID; unknown UUID silently started a new conversation | No per-launch MCP/hook flag verified. Windows native observers tested, real CLI plugin trust/timing unmeasured |
| Copilot | 1.0.95 --help/--version only during this task | No sessions/model calls; hook/MCP shapes, environment values and screen behavior unverified |

## Closed schema and limits

These tables are the complete wire schema. `?` means optional. Objects
reject unknown keys, duplicate JSON member names, unsafe keys (`__proto__`,
`prototype`, `constructor`), dangling references and incompatible combinations.
Arrays are ordered; IDs are unique within their scope. Missing optional arrays default to
[]; arrays explicitly required in these tables must be present, including empty
protection lists. Missing optional objects disable their feature. No implicit agent defaults.
The config folder ships `schemas/agent.schema.json`, generated from the wire parser
by `tests/helpers/agent-schema.ts` (see its regeneration command). A unit test checks
field, enum and bound agreement. Run `foom config validate` for cross-field and
security checks beyond JSON Schema. `examples/agent.json` is a generic starter;
`examples/agent.md` carries field notes because manifests require strict JSON.

| Primitive | Definition |
| --- | --- |
| Manifest | Strict UTF-8 JSON, <=64 KiB original bytes, depth <=24, <=8192 total JSON nodes; no BOM |
| ID | 1–40 lowercase ASCII letters/digits/hyphens, first letter; filename <id>.json; shell and bundled IDs reserved for config files |
| Text | 1–4096 Unicode code units unless narrower below; no Cc/Cf/Co/Cs or U+2028/U+2029; literal rendered text |
| Multiline template | <=16384 bytes each, LF and tab allowed; other hidden/control characters forbidden; aggregate template bytes <=32768 |
| Argv | <=64 nonempty Text entries; <=256 expanded entries/65536 bytes per process invocation, each expanded entry <=20480 bytes (prompt may contain LF/tab); no shell evaluation |
| Relative file | <=100 ASCII characters, <=4 components (fixed home metadata paths <=5); [A-Za-z0-9_.-]+ per component, no empty/dot/dotdot components, drive letters, absolute path, trailing dots or Windows device names; generated files forbid hidden components, metadata paths permit fixed hidden agent roots |
| Selector | `{source,path}`; source payload, header, probe, metadata, facts; path 1–8 literal keys (each <=64) or nonnegative integer indexes <=63; no wildcard, recursion or expressions |
| Condition | `{all?:[Test,...],any?:[Test,...]}` with 1–16 Tests total, no nesting; omitted all is true, omitted any is true; both present means AND of all-tests and any-test; `{all:[]}` alone means unconditional |
| Test | `{field,op,value?}`; field is a named fact or Selector; op eq, in, exists, absent, lt, gte; eq primitive, in <=16 primitives, numeric comparison safe integers only; exists/absent omit value |
| Local fact/case name | 1–40 ASCII letters/digits/underscore/hyphens, first letter; discovery facts cannot shadow engine or setup-derived facts. Unlike provider/channel IDs, these names allow uppercase letters |
| Fact condition | Tests refer only to engine facts or earlier declared discovery/setup/health facts; dependency DAG, no loops; missing/failed fact never satisfies eq/in/lt/gte |
| Argument matcher | One of `{flag,forms,value?}`, `{word}`, `{prefix}`, `{override}`; details below; <=64 per list |

| Root field | Type / limits |
| --- | --- |
| kind, version | Required literals agent, 2 |
| id, name, badge, executables | Required ID, Text <=40, [A-Z0-9]{1,4}, 1–8 basenames <=64 [A-Za-z0-9][A-Za-z0-9_.-]* excluding .cmd/.bat/.ps1 |
| discovery | Required `{version?,facts}`; version `{prefix,suffixes,minimum?}`; prefix/suffixes Text or empty, <=4 suffixes, minimum three safe nonnegative integers; facts <=16 `{id,enabled?,minimum?,helpTokens?,when?}`; enabled boolean defaults true, false is a hard verification gate |
| launch | Required `{order,arguments?,display?,resume?,prompt?,guidance?,mcp?,toolPermissions?}` |
| files? | <=16 File records |
| hooks? | `{channels}`; 1–8 Channel records |
| reservedArguments, bypassArguments, bypassEnvironment | Required matcher arrays (may be empty); environment <=16 records |
| conversation | Required `{newId?,resumePin,restoreControl}`; newId optional `{format:"uuid",arguments:Argv}`; resumePin first-event or requested-on-paste; restoreControl boolean |
| resumePaste | Required <=8 `{command,selector}` token patterns; command basename <=64, selector literal Text <=40; details below |
| attention | Required `{minimumEngineVersion:1,rules,provenance?}`; rules <=64; provenance `{source,license,modified}` each Text <=256; inert, never fetched |
| execution | Required `{completion,completionChannels,providerRules?}`; completion attached or observed; channels <=8 IDs, providerRules <=16 rule IDs |
| health? | `{channel,requiredEvents,completionEvent,promptEvent,review,instructions}`; event arrays <=16 case IDs, instructions Text <=4096; review `{contains,lines,caseSensitive}` <=8 strings <=128, lines 1–40, boolean |
| setup? | `{status,actions,offer?}`; status defined below, actions <=8; offer `{unansweredLabel}` Text <=80 |

`discovery` performs only fixed --version/--help, never arbitrary probe argv.
Version parsing requires exactly three decimal components (no leading zeros except
0), exact prefix and one suffix; prereleases/custom suffixes fail. Version prefix/suffix may be empty (prefix <=4096 code units), and suffix permits LF for the fixed version notice (<=256 bytes); this is the sole non-template Text control exception. Optional
minimum on facts overrides the version-level minimum; no version grammar means
version-dependent facts false. `helpTokens` (<=8, <=128 each) must match complete
option boundaries as in today's probes, not substrings of longer options. A fact
with no minimum/help requirement can depend on setup state. Facts are booleans.
Engine facts are `hooksEnabled`, `control`, `configGreeting`, `hasPrompt`, `resume`,
`healthTrusted`, `setupState`, and `channelAttached:ID` for an earlier hook channel. The latter is evaluated at preparation time, false when absent; discovery cannot depend on it. Missing health is represented by healthTrusted=false. Other facts use declared IDs. healthTrusted is observed
health only. Each declaration without a minimum does not require a parsed version unless discovery.version.minimum is set; this preserves help-only inline/guidance gates. Failed help/version makes its dependent requirements false. Independent status-only facts can still succeed after a resolved executable and successful setup probe, preserving agy enrichment when help/version failed.

### Launch, substitutions and hook files

The parser checks template references and proves each attachment's condition
implies its referenced file/channel condition. This proof is conservative: each
required all-test must occur in the selecting all-tests; a required any-clause
must be guaranteed by one selecting all-test or by a subset selecting any-clause.
Logically equivalent conditions outside this form are rejected rather than guessed.
Actual expanded argv counts and byte limits are checked by the launch
engine after substitution and layering; this parser never expands launch data.


| Object | Closed fields and semantics |
| --- | --- |
| launch.order | Required permutation of resume, defaults, arguments, display, guidance, mcp, hooks, tools, prompt; all once. Defaults engine-controlled; hooks follow channel array order |
| Launch block | `{arguments,when?}`; Argv and Condition. arguments/display/resume/mcp use this shape; resume implies validated requested conversationId |
| prompt | `{arguments,requires?}`; requires fact ID; final task is one argv value. Foom rejects a launch requiring a missing fact |
| guidance | `{when,merge?}`; inserts fixed CLI_GUIDANCE or CONFIG_PROMPT through the prompt stage; merge `{flags,output,separators}` with <=8 flag names, output flag, separators literal whitespace-comma or whitespace; only merges when selected |
| toolPermissions | `{names,format,arguments,merge?}`; names subset of the 17 classified Foom server tools in `src/shared/control-tool-classes.ts`, <=17 unique; format mcp-double-underscore or server-parentheses; arguments template expanded once per tool (unless merge combines); merge `{flags,output,separators:"whitespace-comma-parentheses"}` |
| File | `{name,scope,format,content,when?}`; scope launch or plugin; format json or toml; content multiline template; must parse after typed expansion |
| Channel | `{id,when,observer,arguments,mapping,disclosure?}` |
| observer | `{transport,placement,version,response,delivery,timeoutMs,sequence?,basename?,commandArguments?}`; transport stdin or argv-last; placement launch, stable or plugin; version 1–100000 integer or `{posix,win32}` integers for existing platform ABIs; response silent or empty-json-first; delivery foreground or detached; timeoutMs 1000–3000; sequence boolean default false; basename [A-Za-z][A-Za-z0-9_-]* <=40 default observer; commandArguments <=8 literal event/label tokens [A-Za-z][A-Za-z0-9_-]* <=64, never executable code |
| disclosure | `{id,text,acknowledgement:"profile"}`; ID and Text; bundled channels with disclosures are refused without a consent mechanism; config plugins load without one (#539); never renderer boolean consent |

Allowed placeholders, with no recursion or environment interpolation by Foom:

| Placeholder | Allowed location and type |
| --- | --- |
| {prompt}, {conversationId} | prompt/resume argv respectively; prompt includes main-owned child provenance or config/guidance text, ID validated |
| {newId} | conversation.newId argv only; generated UUID, new launches only |
| {hookDir}, {hookFile:NAME} | hooks.channels[].arguments only; whole owned launch directory/file path. Nested NAME is allowed; declare scope "launch" files |
| {pluginDir} | setup action argv only; owned persistent plugin staging directory |
| {file:NAME} | launch.mcp.arguments only; owned launch file. For hooks use {hookFile:NAME} or {hookDir} |
| {observerCommand:CHANNEL:json}, {observerCommand:CHANNEL:toml} | File content or channel attachment; engine quotes the entire fixed command for JSON/TOML |
| {observerArgv:CHANNEL:json} | JSON array value, File or channel attachment |
| {mcpName}, {mcpUrl}, {tool} | MCP file/argv; tool only toolPermissions arguments; JSON/TOML string positions require :json/:toml suffix |
| {observerVersion:CHANNEL} | Plugin JSON numeric metadata slot |

Known placeholders in the wrong location report `placeholder-not-allowed-here`
with the allowed placeholders for that location. Path arithmetic such as
`{file:plugin.json}/..` or `{hookDir}/sub` reports `placeholder-path-arithmetic`,
even if the placeholder also belongs to another location. Use `{hookDir}` directly
for a generated plugin directory, or declare a nested launch file and refer to its
whole `{hookFile:NAME}`. Prefixes such as `@{file:mcp.json}` remain supported.
Unknown or malformed names still report `unknown-placeholder`. These diagnostics
carry the exact argument/content path; `foom config validate` includes their detail.

A CHANNEL reference may append `.EVENT` to pass that one declared event as a fixed observer argv entry;
command suffixes and header event names must match `[A-Za-z][A-Za-z0-9_-]{0,63}`; this is how an agy handler sets the event header. EVENT must match a mapping event, never payload text.

`:json` serializes a native value; `:toml` serializes a TOML basic string.
Literal JSON/TOML braces are not placeholders. Unknown/malformed placeholders,
references to missing channels/files, unselected launch attachments, secret names or arbitrary environment
variables fail validation. The exact client-side literal `${FOOM_CONTROL_TOKEN}` is permitted only in the MCP Authorization value; it is not a Foom placeholder, and the client must expand it from environment. Other environment references are forbidden. Paths are never escaped by manifest authors. Prefer
native JSON values rather than encoding a JSON string inside another JSON string.
The drafts use :json/:toml only.

Files are data, not executable scripts. Parse hook files and accept command-bearing
values only when their *entire value* is a generated fixed observer invocation;
reject literal commands, appended shell syntax, executable/plugin module entry
points, and unknown executable hook types. JSON/TOML containers share a conservative,
agent-independent data grammar: arbitrary object/array nesting and numeric/boolean
metadata are permitted; literal string leaves are limited to `name`, `version`,
`matcher`, `type` (`command` or `http`), `url`, `Authorization`, and
`bearer_token_env_var`. Command/cmd/bash/powershell slots require an entire fixed
observer value; notify/argv slots require the entire generated observer array.
Validation's `FOOM_OBSERVER_*` and `FOOM_*_SENTINEL` stand-ins cannot be authored
in templates, including through Unicode escapes or TOML line continuations; this
prevents literal values from masquerading as generated slots.
Other string-bearing extension points and script/module/entrypoint/executable/code/
handler/shell/source members reject. A command type requires a command member.
TOML uses the full TOML data parser with depth/node checks; dates and nonfinite
numbers reject. Typed observer-version substitution must occupy a native numeric
slot. Observer-command slots select stdin channels; observer-argv slots select
argv-last channels. MCP files must be referenced by the MCP block and their
conditions must imply that block's selection. Literal environment expansion is
accepted only in those MCP files. URL slots require the complete generated
mcpUrl value; Authorization requires the exact bearer environment reference, and
bearer_token_env_var requires FOOM_CONTROL_TOKEN. Literal remote endpoints or
other credential variables reject. This closes previously unspecified extension-point validation without an
agent-specific container parser. The declarative templates may contain
agent-specific hook container keys, matchers and timeouts, but cannot provide hook
program source. Foom supplies scripts/native transports. Agent CLIs may themselves
run a hook command through a shell; Foom's platform serializer handles quoting
without plugin control of syntax. Setup never runs through a shell.

Launch directories are private 0700/0600 or current-user DACLs, no links, exclusive
creation and containment/identity checks. Revoke credentials before deletion on
exit, failure, kill and shutdown; register cleanup before preparing files. No writes
in the checkout or global agent config. `scope:plugin` generates reviewed persistent
staging data under Foom's profile; copied observer assets contain no credentials. Plugin staging can materialize declared observers even when launch hooks are disabled. placement plugin copies fixed observer.sh/observer.ps1 plus the fixed detached worker under observers/CHANNEL and builds relative invocation commands; their event suffix is fixed. No plugin-supplied script bytes are accepted.
For `placement:stable`, the versioned observer path is stable outside ASAR and
contains no launch identity. Include its path/version and exact hook definitions
in the health fingerprint. Stable names are generated from observer.basename and the per-platform ABI version; commandArguments preserves the legacy literal codex label without code branching. POSIX stable command serialization and Windows encoded invocation must remain byte-identical to the current definition for that ABI. A copied custom manifest can select the same generic
observer ABI without an agent privilege; changing transport behavior bumps the ABI
filename. Stable definitions are essential: placing Codex's command in a random
launch directory would require review every launch. Hook settings files can still
be per-launch because their path is not in the Codex inline definition. Codex
uses declarative templates directly in its six -c argument pairs because the
verified interface is an inline TOML override; this draft invents no file-loading
flag. Other clients consume generated hook files through their verified flag.

Prompt ordering preserves today's resume-before-defaults for bundled providers;
new config manifests choose their declared order. Fixed child prefix is
`Task from your Foom orchestrator (another agent, not the user):`, followed by two
newlines and the task. Validate task nonempty, <=16384 bytes, not leading '-' after
trim, no controls except LF/tab. Positional prompts go last after --; flag prompts
remain a single value. Greeting and CLI guidance are the exact Foom-owned constants
in `providers/cli-launch.ts`, not editable manifest prose. Config resume adds no
greeting; no repository control grant is created. Guidance merges user prompt
aliases/equals forms in order, then appends Foom text with two newlines. Guidance treats each user argv value as literal prompt text, preserving internal whitespace and punctuation; its separators describe the variadic option surface, not words to split inside a prompt. When guidance merge is selected, its canonical `output` flag replaces the prompt argv layout and carries the composed text as one value. Otherwise `prompt.arguments` supplies that layout. The guidance stage collects prompt text and the prompt stage emits it exactly once; no duplicate interactive prompt flags. Config greeting is omitted when the required prompt fact is false, matching agy today; an explicit child task fails instead. Children
use no user default arguments; reject manifest-selected argument/environment bypass
rather than granting unattended bypass. Human role promotion and service tool
permissions never come from manifest text. Availability is not authorization.

Tool merge parses variadic aliases and equals forms; commas/whitespace inside
balanced parentheses belong to the rule. Unbalanced input is refused. Preserve
user rules, deduplicate, and append exact random-server names from the real Foom
server registry only with MCP, filtered by the manifest's classified tool names.
The bundled Claude manifest includes every registered tool (#299), including child
handoffs and orchestration. No allow-all, wildcard, other-server or non-Foom tool
grants are added. Server-side roles and human confirmations remain authoritative;
see the [per-launch disclosure](orchestration.md#claude-code).

### Argument and environment matchers

| Shape | Semantics |
| --- | --- |
| flag + forms | flag matches --?[A-Za-z][A-Za-z0-9-]* <=64, value optional Text <=128, 1–4 unique forms; forms subset of exact, equals, separate, attached-short. exact matches the flag token; equals matches flag=value. separate consumes the next argv token for matching only; attached-short requires a one-letter short flag. Optional value restricts the value; otherwise any value matches. No option permutation/cancellation inference |
| word | Text <=64, exact argv token, useful for resume/fork subcommands |
| prefix | Text <=64, literal prefix match, used to preserve conservative -r/-c selector guards; no regex |
| override | `{flags,keys,value?}`; <=8 flags, <=8 literal dotted key segments. Parse separate, long equals, attached short and -c= forms; normalize key whitespace/single/double quotes as current code. keys match any path segment, or final segment when value supplied. Strip one matching quote pair on values for comparison |
| bypassEnvironment record | `{name,match,values?,caseInsensitive?,trim?}`; name [A-Za-z_][A-Za-z0-9_]* <=64, match present-nonempty or values; values <=16 Text <=128; no reserved/unsafe env names |

The engine always rejects -- and --no-alt-screen (= included) in user defaults,
independently of declared reservations. Match defaults for reservations, and all
selected manifest/default argv for bypass. Environment checks use the final launch
environment (inherited, All sessions, provider list, Foom variables), with Windows
case-insensitive names. Existing environment safety rules and secret storage stay
in force. A matching environment bypass requires a trusted confirmation on every
human launch; only names and match reason are displayed. Loading a manifest
is not this consent. For unverified boolean semantics, present-nonempty is a
conservative disclosure, not a claim the CLI enables bypass for every value.

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

### Detection and resume paste

Detection rules contain: required id, state (working/blocked/idle/unknown),
priority, region (title/bottom/after_horizontal_rule), match, reason; optional lines,
not, comment. IDs use [a-z][a-z0-9_-]* <=40 (underscore preserves bundled rule IDs).
Priority is integer 0–2000. lines 1–40, reason <=128, comment <=256; not <=8 matcher objects.
Matcher has contains? and regex? arrays <=8 strings each, at least one; <=128 each.
Contains entries are conjunctive, case-insensitive as today's detector; regex subset
uses boundedRegex (no groups, repetitions, alternation, backreferences). Matcher
exclusions negate each matching matcher; All contains and regex entries in one matcher are conjunctive. Rules sort descending priority, stable
array order on ties. Bottom defaults to the last 12 nonempty lines; after_horizontal_rule uses the region after the last line of at least three horizontal-divider characters, or all 40 lines if absent, as today. Existing 40-line/500-character line caps, title 512-character
cap and 5 ms evaluation budget stay in code. No new whole-screen or regex engine.

`resumePaste` is a bounded token pattern, not an unbounded capture regex. Trim outer
whitespace; reject internal CR/LF and input >512 characters; split on literal
space/tab; exactly command, selector, ID. Literal command/selector plus the fixed
conversation validator bound the ID capture. This expresses all current forms with
no unsafe quantifiers/groups. Bare valid IDs remain engine behavior with an explicit
agent choice. No quotes, paths, shell syntax, extra flags, optional picker/name/prefix
resume forms, equals form or command execution. Ambiguous matches across active
plugins require explicit provider selection. Renderer may receive validated public
patterns but raw paste stays local; main checks the loaded provider and ID again.

### Setup status and fixed actions

| Object | Closed fields / limits |
| --- | --- |
| status | `{probe?,metadata?,ownership?,cases,default}`; default unavailable; <=16 ordered `{when,state}` cases; state not-installed/installed/outdated/disabled/unavailable |
| probe | `{arguments,format,empty?}`; fixed `plugin list` Argv, format json; empty optional `{text,value}` exact text <=128 and bounded JSON value; timeout 5 s/output 64 KiB engine constants |
| metadata | <=4 `{id,path,optional}`; ID, home-relative Relative file, boolean; read JSON only <=64 KiB each |
| ownership | `{directory,manifest,require,versionField,currentVersion,disabledField,enabledField}`; home-relative directory, metadata ID, <=16 Requirements, Selectors; currentVersion 1–100000; disabledField optional Selector; enabledField optional Selector |
| action | `{id,label,kind,arguments?,instructions?,when,disclosure,statusProbe}`; ID, label <=40; kind command/instructions; exactly argv or instructions Text; disclosure Text <=4096; statusProbe fixed Argv for command or observed-health for instructions |

Setup status selectors may inspect validated metadata and the bounded probe
`imports[index].name` field, in addition to derived facts. No other probe fields
are selectable.

Probe output/metadata is untrusted; cases use facts derived from validated records,
not arbitrary evaluator expressions. Probe JSON validates imports array <=64 and
entries with name Text <=64. Ownership requires real nonlinked expected directory,
manifest name/version and recognized observer identity. The engine derives facts
`owned`, `absent`, `disabled`, `version`: absent means no directory, manifest or list
entry; conflicting/unrecognized/invalid data => unavailable, never absent. Version
safe nonnegative integer; disabled uses enabledField if present, else disabledField;
wrong types => unavailable. Metadata readers are read-only. The current generic reader accepts only
`<hidden-agent-root>/config/plugins/<name>/plugin.json` and the matching
`<hidden-agent-root>/config/config.json`; ownership.directory is the former file's
parent, and its required name is exactly `<name>`. This fixed layout bounds the
read facility; a new layout requires a reviewed schema change. Paths are disclosed exactly,
never exposed through arbitrary file IPC. Other home files (transcripts, secrets,
trust databases) cannot be selected. This reader facility is restricted to plugin
manifest and enabled-state metadata and does not weaken the no-transcript contract.

The current command grammar is `plugin install {pluginDir}`, `plugin enable NAME`,
or `plugin uninstall NAME`, with `plugin list` as the status probe. NAME must equal
the ownership target; the selecting all-clause must restrict setupState to
not-installed/outdated for install, disabled for enable, or
installed/outdated/disabled for uninstall. Install also requires a plugin-scope JSON `plugin.json` whose name is exactly
the ownership target. Action IDs do not choose operations.
Other CLI mutation surfaces require their own reviewed architecture decision.

Command actions use the same resolved agent executable, fixed argv and only
{pluginDir}; no user/payload interpolation, subprocess choice, cwd selection, shell,
stdin program, retries or executable downloads. The content-addressed staging fingerprint covers expanded files and generated observer bytes. Ownership may declare optional `unfingerprintedVersion` (ABI integer), accepting recognized versions at or above that floor only when the fingerprint is absent. An explicit fingerprint mismatch remains outdated. Observer plugins carry `foomStagingFingerprint` in CLI-owned plugin metadata; a changed definition is outdated and offers update even at the same ABI version. Staging verification rejects extra files, links and changed bytes before invoking the CLI. Stage files first for review;
serialize actions per executable/plugin ownership target, re-probe before/after,
re-read manifest bytes and recheck ownership after trusted confirmation. Conflicting
copies share the ownership lock, including case aliases on Windows/macOS. Failed commands report fixed errors and require
rescan, never assume success. Install only absent, update only recognized outdated,
enable only recognized disabled, remove only recognized installed/outdated/disabled.
No other plugin name can be mutated. Instructions are inert UI text: review /hooks
is not a setup command and Foom never sends it into the terminal.

Every command needs a trusted action disclosure, including enable/remove. Current
agy install/update already require trusted disclosure; v2 explicitly extends that
boundary to every setup action. Profile-only offer-answer tracking remains
independent of approval, not editable by config. An unanswered agy offer is a
neutral card label; never a launch modal or silent install. Global mutation is
permitted only for the disclosed opt-in lifecycle plugin CLI path, as today; the
format does not authorize global Claude/Codex/Copilot setup writes. Any new global
mutation integration requires its own reviewed architecture decision.

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

## Migration and acceptance for later implementation

The v2 engine is implemented; older agent manifest formats are unsupported. The Copilot shipping gates below remain future work.

| Input/state | Required migration |
| --- | --- |
| Agent manifest versions | Only version 2 is accepted. Version 1 rejects the file whole with `Agent manifest version 1 is no longer supported; use version 2 (see README.md)`; any other version with `Agent manifest version must be 2 (see README.md)` |
| Bundled defaults/consents | Same IDs/enable switches/default argv/session IDs. Profile acknowledgements map to equivalent disclosure identity only if content/effect unchanged; otherwise ask again. Never import trust from agent stores |
| Codex health | Transfer only identical definition fingerprint; stable observer command/timeout must remain identical for unchanged observer. Changed generated definition invalidates Foom health and lets Codex request review |
| agy plugin | Recognize current foomObserverVersion 2, do not reinstall; newer version supported as today, older offers update, disabled needs enable; unknown foom refuses mutation |
| Config copy of a built-in | Copy with identity changed; full manifest, hand-made (#538 removed the Settings action). No loss of hooks/setup/resume/protections. Consent/observed health not copied; same ownership target serialized across copies |
| Dormant conversations | Missing/invalid provider preserves row/ID but grants no launch; new invocation rechecks the loaded provider and checkout |

Changes to the implemented engine must keep existing unit/Electron/native hook tests passing on
all three OSes, add a manifest-only fixture (no real agent CLI probes), and verify
invalid/changed-byte races, stable Codex definitions/fallback/deduplication, unknown
plugin ownership, setup cancellation, bypass environment redaction, protected argv
forms and prompt/tool merge. Extend offline validation without probing/approval.
Do not lower coverage or relax security to accommodate a template. Copilot shipping
requires human recorded screen captures and isolated hook/MCP measurements; help
alone is not that gate. Parser validation runs `pnpm run check`; tests never run real-agent sessions.

## Bundled manifest delivery (#434)

`src/shared/bundled-agents/` contains data-only JSON imported into the application
bundle by the normal build. `shared/bundled-agent-data.ts` lists these build inputs;
`main/agents/providers/bundled.ts` owns their expected IDs and SHA-256 locks over
`JSON.stringify(importedData)` UTF-8 bytes. Whitespace in the source JSON is not
part of this build lock; object/array order and all parsed values are. The loader
checks the digest, parses with the same strict v2 validator, verifies the expected
identity, and constructs the same immutable `v2Provider` used for config files.
A mismatch or invalid manifest fails startup before any discovery or launch;
there is no fallback to an old provider or a user approval prompt. This detects
an accidentally modified build input, not an attacker who can replace application
code and its lock together. No manifest path, origin, digest, code, include or
module can be nominated by JSON, agent output or renderer IPC.

Bundled manifest revisions travel only in reviewed application builds. A semantic
edit updates the JSON and its code-owned digest together; the digest identifies
that revision and the app version distributes it. Observer behavior changes must
also revise the declared observer ABI; stable definitions/health retain their
separate exact-definition rules. To convert another provider, add its complete
manifest to the build list, pin its ID/digest in the loader, replace its legacy
registration, remove its old policy branches, and add compatibility/failure tests.
The shared catalog reserves all existing built-in IDs throughout conversion;
config registration independently rejects collisions. Config copies change identity
and load as ordinary config plugins; bundled origin/consent is never
copied. Config files cannot claim `bundled` provenance.

Main assigns `origin: bundled` to loaded providers and `providerOrigin: bundled`
to new session records. Existing origin-less Claude rows remain valid with the
same IDs. No settings or profile consent is rewritten: enablement, hooks, defaults,
environment lists and argument-bypass acknowledgements keep the `claude` key.
Bundled argument bypass retains the existing Settings/config-change acknowledgement
flow; environment bypass still requires launch confirmation, and unattended child
bypass always fails. Conversions may reuse an acknowledgement only for an
identical disclosure/effect. They must explicitly preserve setup consent and health observations; bundled build trust never substitutes for those decisions.

Claude compatibility details:

- Resume/default/MCP/merged preview grants/hooks/prompt order and inline `--settings`
  JSON are preserved, including JSON member order. The draft's file attachment is
  valid schema but was corrected to inline JSON to preserve existing argv. The
  standalone file-based fixture remains coverage for the generic file interface.
- The generic observer uses its private `control/lifecycle/observer.sh` or `.ps1`
  canonical path instead of `claude.sh`/`.ps1` (including macOS `/private/var` and expanded Windows short paths), and adds a launch-bound channel header and
  bounded stdin read. Commands use the fixed platform serializer (the same normal-path spelling, with encoded Windows invocation for shell metacharacters);
  MCP JSON retains identical content in the common private launch directory; its temporary parent also changes. No credentials enter settings/argv. Windows still probes interpreter/policy
  before registration. These temporary observer bytes/paths change, with no
  permission decision, global configuration write or change to the 3-second timeout.
- Reduced hook diagnostics now use `plugin:claude:<case-id>` and carry generic
  channel/turn metadata. The restore fixture that directly posts hooks now supplies the launch-bound channel header, as the generated observer does. `idle_prompt` explicitly has `endsTurn:false`; Stop remains
  completion evidence and title-only interruptions remain neutral. Notification
  requirements use the v2 bounded nonempty string contract. Unknown notifications
  remain inert and malformed values fail closed.
- Reserved-argument errors retain agent/line context with generic wording. The
  v2 engine refuses a requested orchestrator restore without actual MCP attachment;
  normal restore already requires this capability. It also rejects malformed
  unbalanced tool rules as the shared grammar requires. Complete help-token matching also accepts tab separators; the captured Claude help still uses the same verified flags.

Antigravity compatibility details (#436):

- The same `agy` settings, defaults, conversation IDs and bypass acknowledgement remain in place. The profile-only legacy offer answer is copied into generic offer tracking; this grants no setup or hook trust. Setup now uses the shared trusted action dialog for install, update, enable and remove. Its status/actions are supplied by the manifest. Unknown ownership still refuses mutation. An explicit plugin preference object with a missing enabled leaf remains unavailable, encoded as an ordered metadata condition. The legacy setup IPC name forwards to these same checks and confirmations.
- `observer.protocol: "ordered-v2"` selects the existing fixed native ordered transport ABI: one plugin channel, stdin, version 2, empty JSON first, detached delivery, sequence counter and one-second network timeout. It retains root-level observer filenames, exact relative commands (`sh ./observer.sh EVENT`, or the existing PowerShell form), and all three native script files byte for byte. It uses `FOOM_HOOK_ORDER` and accepts a missing channel header only for that launch-bound single channel. #467 remains unresolved; no plugin-working-directory assumption was changed.
- `ownership.unfingerprintedVersion: 2` explicitly accepts recognized legacy versions >=2 when the fingerprint is absent. Current version 2 therefore remains installed with no reinstall or update offer, as do newer versions under the previous policy. Older versions offer Update; disabled versions offer Enable. An explicit mismatched fingerprint still offers Update, with separately reviewed staging before `plugin install` runs. This generic compatibility field is available to valid config copies too.
- Staging adds only `foomStagingFingerprint` to `plugin.json`; hooks and observer scripts keep their existing bytes. It does not rewrite an installed plugin. The extra metadata allows subsequent definition changes to offer Update at the same ABI version; users review it through the normal setup dialog. Generic config fixtures without the compatibility protocol retain channel-specific subdirectories and headers.
- Sequenced completion reports rely on validated monotonic sequence deduplication rather than inferred execution-turn deduplication. A newer failure remains visible even if its working report was lost after an earlier completion. Unsequenced lifecycle/notify turn deduplication is unchanged.
- Reduced hook diagnostics use `plugin:agy:<case-id>` plus generic channel/turn metadata. Unknown events are inert (204), without pinning identity or emitting evidence, as for config plugins; malformed known events still fail closed. Reserved defaults and missing prompt-value errors now use generic wording. Tests assert these explained differences while retaining the lifecycle, privacy, ordering, resume and failure checks.

Codex compatibility details (#435):

- The same data engine emits resume → defaults → inline display → MCP → six
  lifecycle definitions → optional notify → prompt. MCP uses the same random
  server name and environment bearer reference; this conversion adds no preview
  tool pre-approval. The complete reservation and bypass matchers include quoted,
  attached-short and nested sandbox overrides.
- Bundled stable observers are build-generated installed assets, outside ASAR;
  config stable observers use private profile paths. This is main-owned build
  provenance, not a manifest privilege. Both use the same ABI generator and
  serializer. The installed `codex-v1.sh` / `codex-v2.ps1` path, trailing literal
  `codex`, six TOML definitions, member order and `timeout=3` are byte-identical
  to the previous provider on both platforms, including special-character paths.
  Independent pre-conversion serializer tests lock those bytes.
- Matching observations in the legacy profile `codex-hook-health.json` migrate
  to the shared private observer directory without rewriting the legacy file.
  The SHA-256 still covers the exact expanded six-definition argv. Bounded,
  identity-checked reads reject links, multiple links and unsafe ownership or
  permissions. Windows permits the old inherited current-user/SYSTEM/local
  Administrators ACL only at this read-only migration boundary; new records are
  protected current-user-only files. A corrupt or stale private record never
  falls back to old trusted data. Changed definitions are outdated; missing or
  malformed data grants no trust. Newer launches alone own writes.
  The generic observed-health engine preserves startup metadata, review text,
  per-turn prompt/Stop observation, late-turn fallback and completion deduplication.
- Bundled Codex attaches notify per launch without warning or confirmation (#633).
  Stored `codexNotifierAcknowledged` values are tolerated and ignored. The generic
  v2 channel `disclosure` mechanism remains available to user manifests.
  Config copies never inherit bundled health. Enablement, defaults, environment scopes,
  argument bypass acknowledgement and dormant conversation IDs keep the same keys.
- Private notify paths now use the generic launch directory. Generated observers
  add a launch-bound channel header and bound input; their timeout, silent
  observe-only behavior and environment-only credentials are unchanged. Reduced
  diagnostics use `plugin:codex:<case-id>` with channel/turn metadata. Tests that
  post directly now identify their channel. Observed-health fields use generic names; notifier acknowledgement plumbing is removed.
  The shipped manifest keeps the existing inline `/hooks in Codex` hint; the
  fixture retains the optional instruction action to exercise that generic surface.
  Reserved-argument errors retain the original agent and argument line with
  engine-owned wording.

## Complete manifests

The four standalone JSON blocks below instantiate this schema without inheritance or external includes. Claude, Codex and Antigravity are shipped bundled manifests. The remaining drafts are parser fixtures pending conversion or verification. Tests use bundled origin to validate reserved identities; config copies need a distinct ID.
Rules for existing agents are copied from current packaged JSON including priority,
provenance and measured limitations. The Copilot draft contains disabled proposed hook and MCP templates, with no setup. They cannot attach until contracts are verified and templates updated in a reviewed application change; it specifies verified
launch surfaces and conservative environment disclosure. Open questions follow.

### Claude Code

```json
{
  "kind": "agent",
  "version": 2,
  "id": "claude",
  "name": "Claude Code",
  "badge": "CC",
  "executables": ["claude"],
  "discovery": {
    "version": {
      "prefix": "",
      "suffixes": ["", " (Claude Code)"]
    },
    "facts": [
      {
        "id": "hookSupport",
        "minimum": [2, 1, 284],
        "helpTokens": ["--settings"]
      },
      {
        "id": "mcpSupport",
        "minimum": [2, 1, 293],
        "helpTokens": ["--mcp-config"]
      }
    ]
  },
  "launch": {
    "order": [
      "resume",
      "defaults",
      "arguments",
      "display",
      "guidance",
      "mcp",
      "tools",
      "hooks",
      "prompt"
    ],
    "arguments": {
      "arguments": []
    },
    "prompt": {
      "arguments": ["--", "{prompt}"]
    },
    "resume": {
      "arguments": ["--resume", "{conversationId}"]
    },
    "mcp": {
      "arguments": ["--mcp-config", "{file:mcp.json}"],
      "when": {
        "all": [
          {
            "field": "control",
            "op": "eq",
            "value": true
          },
          {
            "field": "mcpSupport",
            "op": "eq",
            "value": true
          }
        ]
      }
    },
    "toolPermissions": {
      "names": ["open_preview", "list_previews", "close_preview"],
      "format": "mcp-double-underscore",
      "arguments": ["--allowedTools", "{tool}"],
      "merge": {
        "flags": ["--allowedTools", "--allowed-tools"],
        "output": "--allowedTools",
        "separators": "whitespace-comma-parentheses"
      }
    }
  },
  "files": [
    {
      "name": "mcp.json",
      "scope": "launch",
      "format": "json",
      "content": "{\"mcpServers\":{{mcpName:json}:{\"type\":\"http\",\"url\":{mcpUrl:json},\"headers\":{\"Authorization\":\"Bearer ${FOOM_CONTROL_TOKEN}\"}}}}",
      "when": {
        "all": [
          {
            "field": "control",
            "op": "eq",
            "value": true
          },
          {
            "field": "mcpSupport",
            "op": "eq",
            "value": true
          }
        ]
      }
    }
  ],
  "reservedArguments": [
    {
      "flag": "--settings",
      "forms": ["exact", "equals"]
    },
    {
      "flag": "--safe-mode",
      "forms": ["exact", "equals"]
    },
    {
      "flag": "--bare",
      "forms": ["exact", "equals"]
    },
    {
      "flag": "--resume",
      "forms": ["exact", "equals"]
    },
    {
      "flag": "--continue",
      "forms": ["exact", "equals"]
    },
    {
      "flag": "--session-id",
      "forms": ["exact", "equals"]
    },
    {
      "flag": "--fork-session",
      "forms": ["exact", "equals"]
    },
    {
      "prefix": "-r"
    },
    {
      "prefix": "-c"
    }
  ],
  "bypassArguments": [
    {
      "flag": "--dangerously-skip-permissions",
      "forms": ["exact"]
    },
    {
      "flag": "--permission-mode",
      "forms": ["separate", "equals"],
      "value": "bypassPermissions"
    }
  ],
  "bypassEnvironment": [],
  "conversation": {
    "resumePin": "requested-on-paste",
    "restoreControl": true
  },
  "resumePaste": [
    {
      "command": "claude",
      "selector": "--resume"
    },
    {
      "command": "claude",
      "selector": "-r"
    }
  ],
  "attention": {
    "minimumEngineVersion": 1,
    "rules": [
      {
        "id": "live_blocked_form",
        "state": "blocked",
        "priority": 1200,
        "region": "after_horizontal_rule",
        "match": {
          "contains": ["esc to cancel", "enter to confirm"]
        },
        "reason": "Confirmation requested",
        "comment": "Ported Enter-to-confirm branch; other navigation variants await captures."
      },
      {
        "id": "live_question_form",
        "state": "blocked",
        "priority": 1200,
        "region": "after_horizontal_rule",
        "match": {
          "contains": ["esc to cancel", "enter to select", "↑/↓ to navigate"]
        },
        "reason": "Question form",
        "comment": "Ported live_blocked_form navigation branch; the last divider leaves the form footer visible."
      },
      {
        "id": "osc_title_working",
        "state": "working",
        "priority": 1100,
        "region": "title",
        "match": {
          "regex": ["^[◐◓◑◒] "]
        },
        "reason": "Agent is working",
        "comment": "Half-circle spinner introduced in Claude 2.1.228; captured in 2.1.291. Earlier braille variant omitted without a capture."
      },
      {
        "id": "osc_title_idle",
        "state": "idle",
        "priority": 250,
        "region": "title",
        "match": {
          "regex": ["^✳ "]
        },
        "reason": "Agent turn ended; checking output",
        "comment": "Idle title can coexist with a question form. Screen blockers have higher priority."
      }
    ],
    "provenance": {
      "source": "https://github.com/herdrdev/herdr/tree/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/detect/manifests/claude.toml",
      "license": "Apache-2.0; Herdr contributors (upstream provides no separate copyright notice)",
      "modified": "Modified for Foom: bounded regions, restricted regexes, capture-backed subset and local reasons."
    }
  },
  "execution": {
    "completion": "attached",
    "completionChannels": ["lifecycle"]
  },
  "hooks": {
    "channels": [
      {
        "id": "lifecycle",
        "when": {
          "all": [
            {
              "field": "hooksEnabled",
              "op": "eq",
              "value": true
            },
            {
              "field": "hookSupport",
              "op": "eq",
              "value": true
            }
          ]
        },
        "observer": {
          "transport": "stdin",
          "placement": "launch",
          "version": 1,
          "response": "silent",
          "delivery": "foreground",
          "timeoutMs": 3000
        },
        "arguments": [
          "--settings",
          "{\"hooks\":{\"UserPromptSubmit\":[{\"hooks\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json}}]}],\"PreToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json}}]}],\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json}}]}],\"PermissionRequest\":[{\"hooks\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json}}]}],\"Notification\":[{\"hooks\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json}}]}]}}"
        ],
        "mapping": {
          "session": {
            "source": "payload",
            "path": ["session_id"]
          },
          "event": {
            "source": "payload",
            "path": ["hook_event_name"]
          },
          "cases": [
            {
              "id": "UserPromptSubmit",
              "event": "UserPromptSubmit",
              "action": "working"
            },
            {
              "id": "PreToolUse",
              "event": "PreToolUse",
              "action": "working"
            },
            {
              "id": "Stop",
              "event": "Stop",
              "action": "classify"
            },
            {
              "id": "PermissionRequest",
              "event": "PermissionRequest",
              "action": "needs_input"
            },
            {
              "id": "permission_prompt",
              "event": "Notification",
              "when": {
                "all": [
                  {
                    "field": {
                      "source": "payload",
                      "path": ["notification_type"]
                    },
                    "op": "eq",
                    "value": "permission_prompt"
                  }
                ]
              },
              "require": [
                {
                  "field": {
                    "source": "payload",
                    "path": ["notification_type"]
                  },
                  "type": "string"
                }
              ],
              "action": "needs_input"
            },
            {
              "id": "idle_prompt",
              "event": "Notification",
              "when": {
                "all": [
                  {
                    "field": {
                      "source": "payload",
                      "path": ["notification_type"]
                    },
                    "op": "eq",
                    "value": "idle_prompt"
                  }
                ]
              },
              "require": [
                {
                  "field": {
                    "source": "payload",
                    "path": ["notification_type"]
                  },
                  "type": "string"
                }
              ],
              "action": "classify",
              "endsTurn": false
            }
          ]
        }
      }
    ]
  }
}
```

### Codex

```json
{
  "kind": "agent",
  "version": 2,
  "id": "codex",
  "name": "Codex",
  "badge": "CX",
  "executables": ["codex"],
  "discovery": {
    "version": {"prefix": "codex-cli ", "suffixes": [""]},
    "facts": [
      {"id": "hookSupport", "minimum": [0, 155, 1], "helpTokens": ["-c"]},
      {"id": "lifecycleSupport", "minimum": [0, 161, 0]},
      {"id": "mcpSupport", "minimum": [0, 161, 0], "helpTokens": ["-c"]},
      {"id": "inline", "helpTokens": ["--no-alt-screen"]}
    ]
  },
  "launch": {
    "order": ["resume", "defaults", "arguments", "display", "guidance", "mcp", "hooks", "tools", "prompt"],
    "arguments": {"arguments": []},
    "prompt": {"arguments": ["--", "{prompt}"]},
    "display": {"arguments": ["--no-alt-screen"], "when": {"all": [{"field": "inline", "op": "eq", "value": true}]}},
    "resume": {"arguments": ["resume", "{conversationId}"]},
    "mcp": {
      "arguments": ["-c", "mcp_servers.{mcpName}={url={mcpUrl:toml},bearer_token_env_var=\"FOOM_CONTROL_TOKEN\"}"],
      "when": {
        "all": [{"field": "control", "op": "eq", "value": true}, {"field": "mcpSupport", "op": "eq", "value": true}]
      }
    }
  },
  "files": [],
  "reservedArguments": [
    {"flag": "--dangerously-bypass-hook-trust", "forms": ["exact", "equals"]},
    {"flag": "--last", "forms": ["exact", "equals"]},
    {"flag": "--fork", "forms": ["exact", "equals"]},
    {"word": "resume"},
    {"word": "fork"},
    {"override": {"flags": ["-c", "--config"], "keys": ["notify", "hooks"]}}
  ],
  "bypassArguments": [
    {"flag": "--dangerously-bypass-approvals-and-sandbox", "forms": ["exact"]},
    {"flag": "--sandbox", "forms": ["separate", "equals"], "value": "danger-full-access"},
    {"flag": "-s", "forms": ["separate", "equals", "attached-short"], "value": "danger-full-access"},
    {"override": {"flags": ["-c", "--config"], "keys": ["sandbox_mode"], "value": "danger-full-access"}}
  ],
  "bypassEnvironment": [],
  "conversation": {"resumePin": "requested-on-paste", "restoreControl": true},
  "resumePaste": [{"command": "codex", "selector": "resume"}],
  "attention": {
    "minimumEngineVersion": 1,
    "rules": [
      {
        "id": "provider_capacity",
        "state": "blocked",
        "priority": 1000,
        "region": "bottom",
        "lines": 6,
        "match": {"contains": ["Selected model is at capacity"]},
        "reason": "Provider unavailable",
        "comment": "Working and Action Required titles win over stale provider screens. Provider attention is classification evidence; input authority follows orchestrator ownership (#629). Recorded evidence and limitations: tests/fixtures/agent-detection/README.md."
      },
      {
        "id": "provider_rate_limit",
        "state": "blocked",
        "priority": 1000,
        "region": "bottom",
        "lines": 1,
        "match": {"regex": ["^■ rate limit exceeded:"]},
        "reason": "Provider rate limit",
        "comment": "Working and Action Required titles win over stale provider screens. Provider attention is classification evidence; input authority follows orchestrator ownership (#629). Recorded evidence and limitations: tests/fixtures/agent-detection/README.md."
      },
      {
        "id": "provider_model_switch",
        "state": "blocked",
        "priority": 1000,
        "region": "bottom",
        "lines": 12,
        "match": {"contains": ["Approaching rate limits", "Switch to ", "Keep current model", "enter select · esc back"]},
        "reason": "Model switch requested",
        "comment": "Working and Action Required titles win over stale provider screens. Provider attention is classification evidence; input authority follows orchestrator ownership (#629). Recorded evidence and limitations: tests/fixtures/agent-detection/README.md."
      },
      {
        "id": "provider_usage_limit",
        "state": "blocked",
        "priority": 1000,
        "region": "bottom",
        "lines": 10,
        "match": {
          "contains": ["Usage limit reached", "Request a limit increase from your owner", "enter select · esc back"]
        },
        "reason": "Provider usage limit",
        "comment": "Working and Action Required titles win over stale provider screens. Provider attention is classification evidence; input authority follows orchestrator ownership (#629). Recorded evidence and limitations: tests/fixtures/agent-detection/README.md."
      },
      {
        "id": "osc_title_blocked",
        "state": "blocked",
        "priority": 1100,
        "region": "title",
        "match": {"contains": ["Action Required"]},
        "reason": "Approval requested",
        "comment": "Action Required title takes precedence over spinners. Captured in Codex 0.160.1 approval dialog."
      },
      {
        "id": "osc_title_working",
        "state": "working",
        "priority": 1050,
        "region": "title",
        "match": {"regex": ["^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] "]},
        "reason": "Agent is working",
        "comment": "Captured spinner prefix; broader embedded spinner placement awaits evidence."
      },
      {
        "id": "osc_title_idle",
        "state": "idle",
        "priority": 100,
        "region": "title",
        "match": {"regex": ["\\S"]},
        "reason": "Agent turn ended; checking output",
        "comment": "Idle is evidence for classification, never Done.",
        "not": [{"regex": ["^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] "]}, {"contains": ["Action Required"]}]
      }
    ],
    "provenance": {
      "source": "https://github.com/herdrdev/herdr/tree/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/detect/manifests/codex.toml",
      "license": "Apache-2.0; Herdr contributors (upstream provides no separate copyright notice)",
      "modified": "Modified for Foom: bounded regions, restricted regexes, capture-backed subset and local reasons."
    }
  },
  "execution": {
    "completion": "observed",
    "completionChannels": ["lifecycle", "notify"],
    "providerRules": ["provider_capacity", "provider_rate_limit", "provider_model_switch", "provider_usage_limit"]
  },
  "hooks": {
    "channels": [
      {
        "id": "lifecycle",
        "when": {
          "all": [
            {"field": "hooksEnabled", "op": "eq", "value": true},
            {"field": "hookSupport", "op": "eq", "value": true},
            {"field": "lifecycleSupport", "op": "eq", "value": true}
          ]
        },
        "observer": {
          "transport": "stdin",
          "placement": "stable",
          "version": {"posix": 1, "win32": 2},
          "response": "silent",
          "delivery": "foreground",
          "timeoutMs": 1000,
          "basename": "codex",
          "commandArguments": ["codex"]
        },
        "arguments": [
          "-c",
          "hooks.SessionStart=[{hooks=[{type=\"command\",command={observerCommand:lifecycle:toml},timeout=3}]}]",
          "-c",
          "hooks.UserPromptSubmit=[{hooks=[{type=\"command\",command={observerCommand:lifecycle:toml},timeout=3}]}]",
          "-c",
          "hooks.PreToolUse=[{hooks=[{type=\"command\",command={observerCommand:lifecycle:toml},timeout=3}]}]",
          "-c",
          "hooks.PermissionRequest=[{hooks=[{type=\"command\",command={observerCommand:lifecycle:toml},timeout=3}]}]",
          "-c",
          "hooks.PostToolUse=[{hooks=[{type=\"command\",command={observerCommand:lifecycle:toml},timeout=3}]}]",
          "-c",
          "hooks.Stop=[{hooks=[{type=\"command\",command={observerCommand:lifecycle:toml},timeout=3}]}]"
        ],
        "mapping": {
          "session": {"source": "payload", "path": ["session_id"]},
          "event": {"source": "payload", "path": ["hook_event_name"]},
          "cases": [
            {
              "id": "SessionStart",
              "event": "SessionStart",
              "require": [
                {
                  "field": {"source": "payload", "path": ["source"]},
                  "type": "string",
                  "values": ["startup", "resume", "clear", "compact"]
                }
              ],
              "action": "ready"
            },
            {
              "id": "UserPromptSubmit",
              "event": "UserPromptSubmit",
              "require": [{"field": {"source": "payload", "path": ["turn_id"]}, "type": "identifier"}],
              "action": "working"
            },
            {
              "id": "PreToolUse",
              "event": "PreToolUse",
              "require": [
                {"field": {"source": "payload", "path": ["turn_id"]}, "type": "identifier"},
                {"field": {"source": "payload", "path": ["tool_name"]}, "type": "string"}
              ],
              "action": "working"
            },
            {
              "id": "PermissionRequest",
              "event": "PermissionRequest",
              "require": [
                {"field": {"source": "payload", "path": ["turn_id"]}, "type": "identifier"},
                {"field": {"source": "payload", "path": ["tool_name"]}, "type": "string"}
              ],
              "action": "needs_input"
            },
            {
              "id": "PostToolUse",
              "event": "PostToolUse",
              "require": [
                {"field": {"source": "payload", "path": ["turn_id"]}, "type": "identifier"},
                {"field": {"source": "payload", "path": ["tool_name"]}, "type": "string"}
              ],
              "action": "working"
            },
            {
              "id": "Stop",
              "event": "Stop",
              "require": [
                {"field": {"source": "payload", "path": ["turn_id"]}, "type": "identifier"},
                {"field": {"source": "payload", "path": ["stop_hook_active"]}, "type": "boolean"}
              ],
              "action": "classify"
            }
          ]
        }
      },
      {
        "id": "notify",
        "when": {
          "all": [
            {"field": "hooksEnabled", "op": "eq", "value": true},
            {"field": "hookSupport", "op": "eq", "value": true}
          ],
          "any": [
            {"field": "healthTrusted", "op": "eq", "value": false},
            {"field": "channelAttached:lifecycle", "op": "eq", "value": false}
          ]
        },
        "observer": {
          "transport": "argv-last",
          "placement": "launch",
          "version": 1,
          "response": "silent",
          "delivery": "foreground",
          "timeoutMs": 3000
        },
        "arguments": ["-c", "notify={observerArgv:notify:json}"],
        "mapping": {
          "session": {"source": "payload", "path": ["thread-id"]},
          "event": {"source": "payload", "path": ["type"]},
          "dedupe": {"source": "payload", "path": ["turn-id"]},
          "cases": [
            {
              "id": "agent-turn-complete",
              "event": "agent-turn-complete",
              "require": [{"field": {"source": "payload", "path": ["turn-id"]}, "type": "identifier"}],
              "action": "classify"
            }
          ]
        }
      }
    ]
  },
  "health": {
    "channel": "lifecycle",
    "requiredEvents": ["SessionStart", "UserPromptSubmit", "Stop"],
    "completionEvent": "Stop",
    "promptEvent": "UserPromptSubmit",
    "instructions": "/hooks in Codex",
    "review": {"contains": ["Hooks need review"], "lines": 20, "caseSensitive": true}
  }
}
```

### Antigravity

```json
{
  "kind": "agent",
  "version": 2,
  "id": "agy",
  "name": "Antigravity",
  "badge": "AG",
  "executables": ["agy"],
  "discovery": {
    "version": {"prefix": "", "suffixes": [""]},
    "facts": [
      {"id": "guidance", "helpTokens": ["--prompt-interactive"]},
      {
        "id": "hookSupport",
        "when": {"all": [{"field": "setupState", "op": "in", "value": ["installed", "outdated"]}]}
      }
    ]
  },
  "launch": {
    "order": ["resume", "defaults", "arguments", "display", "guidance", "mcp", "hooks", "tools", "prompt"],
    "arguments": {"arguments": []},
    "prompt": {"arguments": ["--prompt-interactive", "{prompt}"], "requires": "guidance"},
    "resume": {"arguments": ["--conversation", "{conversationId}"]},
    "guidance": {
      "when": {
        "all": [{"field": "guidance", "op": "eq", "value": true}],
        "any": [
          {"field": "control", "op": "eq", "value": true},
          {"field": "configGreeting", "op": "eq", "value": true}
        ]
      },
      "merge": {"flags": ["--prompt-interactive", "-i"], "output": "--prompt-interactive", "separators": "whitespace"}
    }
  },
  "files": [
    {
      "name": "plugin.json",
      "scope": "plugin",
      "format": "json",
      "content": "{\"name\":\"foom\",\"version\":\"1.0.0\",\"foomObserverVersion\":{observerVersion:lifecycle}}"
    },
    {
      "name": "hooks.json",
      "scope": "plugin",
      "format": "json",
      "content": "{\"foom-observer-v1\":{\"PreInvocation\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle.PreInvocation:json},\"timeout\":3}],\"PostToolUse\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle.PostToolUse:json},\"timeout\":3}]}],\"Stop\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle.Stop:json},\"timeout\":3}]}}"
    }
  ],
  "reservedArguments": [
    {"flag": "--conversation", "forms": ["exact", "equals"]},
    {"flag": "--continue", "forms": ["exact", "equals"]},
    {"prefix": "-c"}
  ],
  "bypassArguments": [{"flag": "--dangerously-skip-permissions", "forms": ["exact"]}],
  "bypassEnvironment": [],
  "conversation": {"resumePin": "requested-on-paste", "restoreControl": false},
  "resumePaste": [{"command": "agy", "selector": "--conversation"}],
  "attention": {
    "minimumEngineVersion": 1,
    "rules": [
      {
        "id": "trust_prompt",
        "state": "blocked",
        "priority": 280,
        "region": "bottom",
        "match": {
          "contains": ["do you trust the contents of this project?", "yes, i trust this folder", "enter confirm"]
        },
        "reason": "Workspace trust requested",
        "comment": "Trust dialog footer; bottom nonempty lines exclude blank padding.",
        "lines": 8
      }
    ],
    "provenance": {
      "source": "https://github.com/herdrdev/herdr/tree/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/detect/manifests/antigravity.toml",
      "license": "Apache-2.0; Herdr contributors (upstream provides no separate copyright notice)",
      "modified": "Modified for Foom: bounded regions, restricted regexes, capture-backed subset and local reasons."
    }
  },
  "execution": {"completion": "attached", "completionChannels": ["lifecycle"]},
  "hooks": {
    "channels": [
      {
        "id": "lifecycle",
        "when": {
          "all": [
            {"field": "hooksEnabled", "op": "eq", "value": true},
            {"field": "hookSupport", "op": "eq", "value": true}
          ]
        },
        "observer": {
          "transport": "stdin",
          "placement": "plugin",
          "version": 2,
          "response": "empty-json-first",
          "delivery": "detached",
          "timeoutMs": 1000,
          "sequence": true,
          "protocol": "ordered-v2"
        },
        "arguments": [],
        "mapping": {
          "session": {"source": "payload", "path": ["conversationId"]},
          "event": {"source": "header", "path": ["X-Foom-Event"]},
          "sequence": {"source": "header", "path": ["X-Foom-Sequence"]},
          "cases": [
            {"id": "PreInvocation", "event": "PreInvocation", "action": "working"},
            {"id": "PostToolUse", "event": "PostToolUse", "action": "working"},
            {
              "id": "stop-failed",
              "event": "Stop",
              "when": {
                "all": [
                  {
                    "field": {"source": "payload", "path": ["terminationReason"]},
                    "op": "in",
                    "value": ["error", "max_steps_exceeded"]
                  }
                ]
              },
              "require": [
                {
                  "field": {"source": "payload", "path": ["terminationReason"]},
                  "type": "string",
                  "values": ["model_stop", "NO_TOOL_CALL", "max_steps_exceeded", "error"]
                },
                {"field": {"source": "payload", "path": ["fullyIdle"]}, "type": "boolean"}
              ],
              "action": "failed",
              "facts": [
                {
                  "name": "terminationReason",
                  "field": {"source": "payload", "path": ["terminationReason"]},
                  "aliases": {"NO_TOOL_CALL": "model_stop"}
                },
                {"name": "fullyIdle", "field": {"source": "payload", "path": ["fullyIdle"]}}
              ]
            },
            {
              "id": "stop-background",
              "event": "Stop",
              "when": {"all": [{"field": {"source": "payload", "path": ["fullyIdle"]}, "op": "eq", "value": false}]},
              "require": [
                {
                  "field": {"source": "payload", "path": ["terminationReason"]},
                  "type": "string",
                  "values": ["model_stop", "NO_TOOL_CALL", "max_steps_exceeded", "error"]
                },
                {"field": {"source": "payload", "path": ["fullyIdle"]}, "type": "boolean"}
              ],
              "action": "working",
              "facts": [
                {
                  "name": "terminationReason",
                  "field": {"source": "payload", "path": ["terminationReason"]},
                  "aliases": {"NO_TOOL_CALL": "model_stop"}
                },
                {"name": "fullyIdle", "field": {"source": "payload", "path": ["fullyIdle"]}}
              ]
            },
            {
              "id": "stop-idle",
              "event": "Stop",
              "when": {"all": [{"field": {"source": "payload", "path": ["fullyIdle"]}, "op": "eq", "value": true}]},
              "require": [
                {
                  "field": {"source": "payload", "path": ["terminationReason"]},
                  "type": "string",
                  "values": ["model_stop", "NO_TOOL_CALL", "max_steps_exceeded", "error"]
                },
                {"field": {"source": "payload", "path": ["fullyIdle"]}, "type": "boolean"}
              ],
              "action": "classify",
              "facts": [
                {
                  "name": "terminationReason",
                  "field": {"source": "payload", "path": ["terminationReason"]},
                  "aliases": {"NO_TOOL_CALL": "model_stop"}
                },
                {"name": "fullyIdle", "field": {"source": "payload", "path": ["fullyIdle"]}}
              ],
              "recoverTurn": true
            }
          ]
        }
      }
    ]
  },
  "setup": {
    "status": {
      "probe": {
        "arguments": ["plugin", "list"],
        "format": "json",
        "empty": {"text": "No imported plugins.", "value": {"imports": []}}
      },
      "metadata": [
        {"id": "manifest", "path": ".gemini/config/plugins/foom/plugin.json", "optional": true},
        {"id": "config", "path": ".gemini/config/config.json", "optional": true}
      ],
      "ownership": {
        "directory": ".gemini/config/plugins/foom",
        "manifest": "manifest",
        "require": [
          {"field": {"source": "metadata", "path": ["manifest", "name"]}, "type": "string", "values": ["foom"]},
          {"field": {"source": "metadata", "path": ["manifest", "foomObserverVersion"]}, "type": "integer"}
        ],
        "versionField": {"source": "metadata", "path": ["manifest", "foomObserverVersion"]},
        "currentVersion": 2,
        "unfingerprintedVersion": 2,
        "disabledField": {"source": "metadata", "path": ["manifest", "disabled"]},
        "enabledField": {"source": "metadata", "path": ["config", "plugins", "foom", "enabled"]}
      },
      "cases": [
        {
          "when": {"all": [
            {"field": "owned", "op": "eq", "value": true},
            {"field": {"source": "metadata", "path": ["config", "plugins", "foom"]}, "op": "exists"},
            {"field": {"source": "metadata", "path": ["config", "plugins", "foom", "enabled"]}, "op": "absent"}
          ]},
          "state": "unavailable"
        },
        {"when": {"all": [{"field": "absent", "op": "eq", "value": true}]}, "state": "not-installed"},
        {
          "when": {
            "all": [{"field": "owned", "op": "eq", "value": true}, {"field": "disabled", "op": "eq", "value": true}]
          },
          "state": "disabled"
        },
        {
          "when": {"all": [{"field": "owned", "op": "eq", "value": true}, {"field": "version", "op": "lt", "value": 2}]},
          "state": "outdated"
        },
        {"when": {"all": [{"field": "owned", "op": "eq", "value": true}]}, "state": "installed"}
      ],
      "default": "unavailable"
    },
    "actions": [
      {
        "id": "install",
        "label": "Install",
        "kind": "command",
        "arguments": ["plugin", "install", "{pluginDir}"],
        "when": {"all": [{"field": "setupState", "op": "in", "value": ["not-installed"]}]},
        "disclosure": "CLI-owned opt-in Foom lifecycle plugin at ~/.gemini/config/plugins/foom; observes only Foom launches, approves no tools, stores no credentials. Remove with agy plugin uninstall foom.",
        "statusProbe": ["plugin", "list"]
      },
      {
        "id": "update",
        "label": "Update",
        "kind": "command",
        "arguments": ["plugin", "install", "{pluginDir}"],
        "when": {"all": [{"field": "setupState", "op": "in", "value": ["outdated"]}]},
        "disclosure": "CLI-owned opt-in Foom lifecycle plugin at ~/.gemini/config/plugins/foom; observes only Foom launches, approves no tools, stores no credentials. Remove with agy plugin uninstall foom.",
        "statusProbe": ["plugin", "list"]
      },
      {
        "id": "enable",
        "label": "Enable",
        "kind": "command",
        "arguments": ["plugin", "enable", "foom"],
        "when": {"all": [{"field": "setupState", "op": "in", "value": ["disabled"]}]},
        "disclosure": "CLI-owned opt-in Foom lifecycle plugin at ~/.gemini/config/plugins/foom; observes only Foom launches, approves no tools, stores no credentials. Remove with agy plugin uninstall foom.",
        "statusProbe": ["plugin", "list"]
      },
      {
        "id": "remove",
        "label": "Remove",
        "kind": "command",
        "arguments": ["plugin", "uninstall", "foom"],
        "when": {"all": [{"field": "setupState", "op": "in", "value": ["installed", "outdated", "disabled"]}]},
        "disclosure": "CLI-owned opt-in Foom lifecycle plugin at ~/.gemini/config/plugins/foom; observes only Foom launches, approves no tools, stores no credentials. Remove with agy plugin uninstall foom.",
        "statusProbe": ["plugin", "list"]
      }
    ],
    "offer": {"unansweredLabel": "Plugin available"}
  }
}
```

### GitHub Copilot CLI 1.0.95

```json
{
  "kind": "agent",
  "version": 2,
  "id": "copilot",
  "name": "GitHub Copilot",
  "badge": "CP",
  "executables": ["copilot"],
  "discovery": {
    "version": {
      "prefix": "GitHub Copilot CLI ",
      "suffixes": [".", ".\nRun 'copilot update' to check for updates."],
      "minimum": [1, 0, 95]
    },
    "facts": [
      {"id": "promptSupport", "minimum": [1, 0, 95], "helpTokens": ["--interactive"]},
      {"id": "mcpSurface", "minimum": [1, 0, 95], "helpTokens": ["--additional-mcp-config", "--allow-tool"]},
      {"id": "pluginSurface", "minimum": [1, 0, 95], "helpTokens": ["--plugin-dir"]},
      {
        "id": "mcpVerified",
        "enabled": false,
        "when": {"all": [{"field": "mcpSurface", "op": "eq", "value": true}]}
      },
      {
        "id": "hookVerified",
        "enabled": false,
        "when": {"all": [{"field": "pluginSurface", "op": "eq", "value": true}]}
      }
    ]
  },
  "launch": {
    "order": ["resume", "defaults", "arguments", "display", "guidance", "mcp", "hooks", "tools", "prompt"],
    "arguments": {"arguments": []},
    "prompt": {"arguments": ["--interactive", "{prompt}"], "requires": "promptSupport"},
    "resume": {"arguments": ["--resume", "{conversationId}"]},
    "mcp": {
      "arguments": ["--additional-mcp-config", "@{file:mcp.json}"],
      "when": {
        "all": [{"field": "control", "op": "eq", "value": true}, {"field": "mcpVerified", "op": "eq", "value": true}]
      }
    },
    "toolPermissions": {
      "names": ["open_preview", "list_previews", "close_preview"],
      "format": "server-parentheses",
      "arguments": ["--allow-tool", "{tool}"]
    }
  },
  "files": [
    {
      "name": "mcp.json",
      "scope": "launch",
      "format": "json",
      "content": "{\"mcpServers\":{{mcpName:json}:{\"type\":\"http\",\"url\":{mcpUrl:json},\"headers\":{\"Authorization\":\"Bearer ${FOOM_CONTROL_TOKEN}\"}}}}",
      "when": {
        "all": [{"field": "control", "op": "eq", "value": true}, {"field": "mcpVerified", "op": "eq", "value": true}]
      }
    },
    {
      "name": "plugin.json",
      "scope": "launch",
      "format": "json",
      "content": "{\"name\":\"foom-observer\",\"version\":\"1.0.0\"}",
      "when": {
        "all": [
          {"field": "hooksEnabled", "op": "eq", "value": true},
          {"field": "hookVerified", "op": "eq", "value": true}
        ]
      }
    },
    {
      "name": "hooks.json",
      "scope": "launch",
      "format": "json",
      "content": "{\"hooks\":{\"SessionStart\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}],\"UserPromptSubmit\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}],\"PreToolUse\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}],\"PermissionRequest\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}],\"PostToolUse\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}],\"Stop\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}]}}",
      "when": {
        "all": [
          {"field": "hooksEnabled", "op": "eq", "value": true},
          {"field": "hookVerified", "op": "eq", "value": true}
        ]
      }
    }
  ],
  "reservedArguments": [
    {"flag": "--resume", "forms": ["exact", "equals"]},
    {"flag": "--continue", "forms": ["exact", "equals"]},
    {"flag": "--session-id", "forms": ["exact", "equals"]},
    {"flag": "--connect", "forms": ["exact", "equals"]},
    {"prefix": "-r"}
  ],
  "bypassArguments": [
    {"flag": "--yolo", "forms": ["exact", "equals"]},
    {"flag": "--allow-all", "forms": ["exact", "equals"]},
    {"flag": "--allow-all-tools", "forms": ["exact", "equals"]},
    {"flag": "--allow-all-paths", "forms": ["exact", "equals"]},
    {"flag": "--allow-all-urls", "forms": ["exact", "equals"]}
  ],
  "bypassEnvironment": [{"name": "COPILOT_ALLOW_ALL", "match": "present-nonempty"}],
  "conversation": {
    "resumePin": "requested-on-paste",
    "restoreControl": false,
    "newId": {"format": "uuid", "arguments": ["--session-id", "{newId}"]}
  },
  "resumePaste": [{"command": "copilot", "selector": "--resume"}, {"command": "copilot", "selector": "-r"}],
  "attention": {
    "minimumEngineVersion": 1,
    "rules": [
      {
        "id": "selection-0-0",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc to cancel", "enter to select"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-0-1",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc to cancel", "enter to confirm"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-0-2",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc to cancel", "enter to submit"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-0-3",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc to cancel", "enter accept"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-1-0",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc cancel", "enter to select"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-1-1",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc cancel", "enter to confirm"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-1-2",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc cancel", "enter to submit"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-1-3",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc cancel", "enter accept"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "background-agents",
        "state": "working",
        "priority": 110,
        "region": "bottom",
        "lines": 6,
        "match": {"contains": ["◎", "Waiting for background agents"]},
        "reason": "Waiting for background agents",
        "comment": "Bounded approximation of Herdr line regex; requires captures before shipping."
      },
      {
        "id": "working-cancel-0",
        "state": "working",
        "priority": 100,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc to cancel"]},
        "reason": "Agent is working",
        "comment": "Herdr cancel hint; selection blockers outrank it; unmeasured."
      },
      {
        "id": "working-cancel-1",
        "state": "working",
        "priority": 100,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc cancel"]},
        "reason": "Agent is working",
        "comment": "Herdr cancel hint; selection blockers outrank it; unmeasured."
      },
      {
        "id": "working-cancel-2",
        "state": "working",
        "priority": 100,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc again to cancel"]},
        "reason": "Agent is working",
        "comment": "Herdr cancel hint; selection blockers outrank it; unmeasured."
      },
      {
        "id": "working-cancel-3",
        "state": "working",
        "priority": 100,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc interrupt"]},
        "reason": "Agent is working",
        "comment": "Herdr cancel hint; selection blockers outrank it; unmeasured."
      }
    ],
    "provenance": {
      "source": "inspiration/herdr/src/detect/manifests/github-copilot.toml (2026.08.29.1)",
      "license": "Apache-2.0; Herdr contributors",
      "modified": "Draft bounded translation: 8 selection conjunctions, 1 background approximation, 4 cancel hints; no idle rule or real screen measurement."
    }
  },
  "execution": {"completion": "observed", "completionChannels": ["lifecycle"]},
  "hooks": {
    "channels": [
      {
        "id": "lifecycle",
        "when": {
          "all": [
            {"field": "hooksEnabled", "op": "eq", "value": true},
            {"field": "hookVerified", "op": "eq", "value": true}
          ]
        },
        "observer": {
          "transport": "stdin",
          "placement": "launch",
          "version": 1,
          "response": "silent",
          "delivery": "foreground",
          "timeoutMs": 3000
        },
        "arguments": ["--plugin-dir", "{hookDir}"],
        "mapping": {
          "session": {"source": "payload", "path": ["session_id"]},
          "event": {"source": "payload", "path": ["hook_event_name"]},
          "cases": [
            {"id": "SessionStart", "event": "SessionStart", "action": "ready"},
            {"id": "UserPromptSubmit", "event": "UserPromptSubmit", "action": "working"},
            {"id": "PreToolUse", "event": "PreToolUse", "action": "working"},
            {"id": "PermissionRequest", "event": "PermissionRequest", "action": "needs_input"},
            {"id": "PostToolUse", "event": "PostToolUse", "action": "working"},
            {"id": "Stop", "event": "Stop", "action": "classify"}
          ]
        }
      }
    ]
  }
}
```

## Open questions and shipping gates

| Question | Evidence / next verification; no implied support |
| --- | --- |
| Copilot hooks through --plugin-dir | 1.0.95 top-level help proves local directory loading only. It does not document plugin.json/hooks.json layout, event names, stdin/argv, permissions or decisions. Draft hookVerified is false; its plugin.json/hooks.json and PascalCase stdin mapping are hypotheses, not evidence. Verify official contract and isolated human lifecycle probe before adding templates; never infer Claude-compatible hooks |
| Copilot MCP auth | Help proves session-additive JSON/@file and --allow-tool server syntax, not HTTP config layout or ${FOOM_CONTROL_TOKEN} expansion. Draft MCP file is a proposed shape held behind false mcpVerified. Verify environment-only bearer transport; never put token in file/argv or use --mcp-github-auth to forward account credentials |
| COPILOT_ALLOW_ALL values | Help refers to an environment help topic which this task did not run. Truthy values/exact true scope unverified; draft discloses every nonempty value. Replace only with measured documented predicate after review |
| Copilot screens | Read-only Herdr reference at main checkout inspiration/herdr/src/detect/manifests/github-copilot.toml 2026.08.29.1, also distribution copy. 13 draft rules are translations, not captures. Original whole_recent becomes bottom 40; background regex becomes bounded conjunction. No Herdr idle rule exists: idle/working/blocked real captures required for #410; unmatched stays neutral |
| Copilot resume/new UUID | Help advertises -r/--resume ID/name/prefix and --session-id sets UUID or resumes. Draft deliberately accepts full validated IDs only. Verify UUID equality and unknown-ID behavior by a human; restoreControl false until verified |
| Copilot --no-alt-screen | Not advertised in captured help. No inline fact/display flag; do not infer --screen-reader is equivalent |
| Cross-platform agent contracts | Existing measurements in agents.md are Linux only; native transport CI is not real CLI trust/timing proof. No new Claude/Codex/agy session or model call was run for this spec |
| Stable observer definitions during conversion | Preserve exact current Codex POSIX v1 / Windows v2 command spelling and timeout. The draft versions explicitly preserve POSIX 1 / Windows 2; implementation must preserve platform command serialization and filenames. New behavior/path requires review |
| Antigravity status safety | CLI list omits needed metadata. Generic fixed read-only metadata is necessary; parser must bound config structure and never surface other fields. Keep unknown installation unavailable and never overwrite; no arbitrary home reader |
| Antigravity compatibility | Current code permits installed observer versions >=2 and outdated <2. Require compatibility tests for old Stop/ordering behavior before assuming every recognized integer version is launchable |
| JSON templates and trust surface | Implement parsing/command-slot validation for arbitrary JSON/TOML containers without an agent-specific parser. Unknown executable extension points must reject; a template that cannot be proven observer-only is invalid, not a privileged built-in escape hatch |

Copilot help/version observed on 2026-10-14 on Linux from
`/home/slindsey/.nvm/versions/node/v25.0.0/bin/copilot`, running only --help/--version
under the existing Node 24 environment. No interactive session, topic/subcommand,
plugin operation, account login or model prompt was run. The fresh worktree lacks
inspiration/, so the reference was read in the main checkout
`/var/www/html/scott/foom/inspiration/herdr`; it was not edited or tested.

### Offline capability report

`foom config validate PATH` reports Attention, Completion, Resume, MCP, Foom tools
and bypass coverage for each valid agent manifest. It uses only the parsed v2
manifest; it never discovers or runs an agent. Probe-dependent and launch-dependent
conditions remain gated by facts. Permanently disabled discovery facts propagate
through dependent facts and hook channels.

Warnings do not fail validation: no attention signal, resume without an automatic
ID source, and hooks or MCP behind an always-disabled fact. A resume command
without an automatic ID source is reported as paste only. Settings → Agents shows
**No attention signal** in the Attention row when neither screen rules nor an
attachable hook channel is declared.

`--json` returns `{ "problems": [], "agents": [] }`. Each agent report includes its
ID, rule count, ordered hook-channel availability, completion policy, resume
classification, MCP and Foom-tool availability, bypass matcher/environment counts,
and fixed warning strings. Counts and ordered channel entries deliberately avoid
echoing manifest-authored names, flags, environment names or prose. The text
report uses the same fixed vocabulary. Availability is `off`, `gated by facts` or
`on`; hooks that are on are labelled enabled-by-default in text. This describes
manifest capability, not the current profile's hooks preference or CLI installation.

The optional warning about bypass flags in CLI help is skipped: offline validation
has no previously captured help output, and never runs a help probe.
