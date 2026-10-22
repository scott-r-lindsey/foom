# Agent Launch

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
| {file:NAME} | launch.mcp.arguments or an entire launch.environment[].value; owned launch file. For hooks use {hookFile:NAME} or {hookDir} |
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
argv-last channels. MCP files must be referenced by the MCP block or a launch environment entry whose condition implies the MCP block, and their
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
staging data under Foom's profile; copied observer assets contain no credentials. Plugin staging can materialize declared observers even when launch hooks are disabled. placement plugin copies fixed observer.sh/observer.ps1 plus the fixed detached worker under observers/CHANNEL and builds absolute invocation commands anchored to the immutable staging directory; their event suffix is fixed. Ordered observers retain root-level filenames. The CLI may copy the plugin, but hooks continue to use the reviewed staging paths, never the session cwd. No plugin-supplied script bytes are accepted.
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
see the [per-launch disclosure](mcp-attachment.md#claude-code).

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

## Default argument policy

In Settings, each flag and value occupies its own line. All three help outputs advertise `--model`; Claude and Antigravity
advertise `--effort`, while Codex accepts `-c` followed by
`model_reasoning_effort="high"`. Values and quotes are passed unchanged as argv,
not evaluated by a shell. LF and CRLF line endings are accepted; trailing empty
lines are ignored. Interior empty lines remain errors, and validation identifies
the agent and line. Empty defaults preserve the prior launch behavior.

Settings stores arrays in main (maximum 64 arguments per agent, 1–4096 characters
each, no control characters). User defaults precede Foom's own arguments.
On profile load, an invalid or newly reserved list is discarded only for that
agent; other agents' defaults and unrelated settings are retained. Save requests
remain strict and reject the entire invalid patch.
Claude `--settings` (including `=` form), `--safe-mode` and `--bare` are reserved
to protect hooks (`--bare` skips hooks defined in settings and plugins).
`--no-alt-screen` is reserved for Foom's display. Codex overrides whose key path sets `notify` or `hooks` are rejected, including `-c notify=…`,
`--config=notify=…`, attached short forms and nested keys. The `--` terminator is
also rejected because it would turn Foom's flags into positional arguments.

Conversation selectors are reserved for Foom's session actions: Claude resume,
continue, session-ID and fork-session flags; Codex `resume`/`fork` commands and
`--last`/`--fork`; Antigravity conversation/continue flags. This prevents launch
defaults from redirecting Resume or turning New conversation into a continuation.
Other agent arguments retain the existing validation and literal argv behavior.

The fixed bypass table includes Claude/Antigravity `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, and Claude's
`--permission-mode bypassPermissions` and `--permission-mode=bypassPermissions`.
Codex `danger-full-access` also triggers disclosure and the badge: `--sandbox`
or `-s` (separate, `=` or attached short value), and `-c`/`--config`
`sandbox_mode` overrides (bare, single-quoted or double-quoted values). This is
conservative: full filesystem access is flagged even when approvals are still
required, and a later flag does not cancel the disclosure.
The first save of any of those forms per agent requires a main-owned confirmation:
a worktree is not a sandbox, and the agent can act as the user anywhere on the
machine. A successful save persists that agent's acknowledgement; cancelling or
a failed write does not. Renderer requests cannot set acknowledgement themselves.
Rows show a neutral ◇ Bypass label based on the arguments at launch. This does not
infer policy from global settings or every possible combination of arguments.
`--allow-dangerously-skip-permissions` alone does not enable bypass mode.

## Per-launch manifest environment (#636)

`launch.environment` is an optional list of at most eight `{name,value,when?}`
entries. Names match `^[A-Za-z_][A-Za-z0-9_]*$`, maximum 64 characters,
and must be unique ignoring case. Values are either a whole `{file:NAME}`
reference to a declared launch file or a fixed nonempty literal of at most 128
characters. No controls, other placeholders, interpolation, dollar signs,
percent signs or backticks are accepted. A variable's condition must imply its
file's condition; plugin-scope files cannot be referenced.

Names are refused ignoring case for prefixes `LD_`, `DYLD_`, `NODE_`, `PYTHON`,
`BUN_`, `DENO_`, `NPM_CONFIG_`, `YARN_`, `PNPM_`, `LUA_`, `PERL5`, `RUBY`,
`GIT_`, `SSH_`, `AWS_`, `GITHUB_`, `GH_`, `FOOM_`, `ELECTRON_`;
any name containing `TOKEN`, `SECRET`, `KEY`, `PASSWORD` or `PROXY`; and the exact
names `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, `PATH`, `HOME`,
`SHELL`, `BASH_ENV`, `ENV`, `PS4`, `IFS`, `ZDOTDIR`, `PROMPT_COMMAND`, `CLAUDECODE`,
`EDITOR`, `VISUAL`, `PAGER`, `BROWSER`, `MANPAGER`, `LESSOPEN`, `LESSCLOSE`,
`PERLLIB`, `GCONV_PATH`, `LOCPATH`, `HOSTALIASES`, `RES_OPTIONS`, `LOCALDOMAIN`,
`TMPDIR`, `TERM`, `COLORTERM`, `TERM_PROGRAM`, `CONSTRUCTOR`, `PROTOTYPE`, `__PROTO__`.
The manifest cannot obtain inherited values or set credentials.

Main selects entries after discovery and hook facts, expands only owned file
paths and layers these values after user Environment lists and before Foom's
reserved launch variables. Windows reuses existing variable spelling. Session
metadata records names only. Bypass inspection and disclosure use the final
environment, including manifest entries; unattended children and probes refuse
matching bypass values. Probe discovery receives no manifest launch environment.
Validation reports the entry's exact path and reason through `foom config validate`.
