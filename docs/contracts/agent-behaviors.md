# Agent Behaviors

## Behavior inventory and representation

This inventory maps current behavior to v2 data and engine responsibilities. Owners:
`src/shared/agent-plugin-parser.ts`, `agent-manifest-v2.d.ts`, `providers/{catalog,arguments}.ts`,
`src/main/agents/providers/*.ts`, `src/main/agents/*.ts`,
`src/main/config/service.ts`, `src/renderer/board/resume-field.ts`, and workspace
execution/health integration. The v2 fixture is `tests/fixtures/agent-plugin.json`.

| Current behavior | v2 data | Generic engine responsibility |
| --- | --- | --- |
| Resolve claude/codex/agy on login PATH; fixed help/version, 5 s, 256 KiB; ignore relative PATH entries and Windows wrappers | `executables`, `discovery` | Resolve and probe only loaded providers; keep full version; fail capability facts closed |
| Claude hooks: stable >=2.1.284 plus complete --settings; Codex notify >=0.155.1 plus -c; lifecycle >=0.161.0 (currently version-only) | Version grammar and help-token predicates | Numeric stable-version comparison with no upper bound; no manifest regex for version extraction |
| Claude MCP >=2.1.293 + --mcp-config; Codex MCP >=0.161.0 + -c; agy >=1.4.2 with the intact enabled Foom v4 plugin | `discovery.facts`, conditional launch blocks | MCP fact independent of hooks; agy plugin launchers use only inherited credentials; policy denial is not permission to weaken client settings |
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
| Children use user defaults, refusing bypass defaults; fixed provenance prefix; Claude/Codex -- prompt last, agy interactive prompt; fallback CLI guidance covers later human role change and is omitted with the current MCP plugin | Prompt policy, guidance fact | Validate <=16 KiB prompt; role grants, child limits, fresh credentials and PATH stay in main |
| Claude MCP merges variadic/comma-separated allowedTools/allowed-tools including equals forms, preserving separators inside parentheses; every tool on Foom’s own per-launch server pre-approved | `toolPermissions` merge grammar and names | Deduplicate without widening roles; deny/managed policy still wins; no grants without MCP |
| Restore orchestrator currently verified only for Claude/Codex; agy false | `conversation.restoreControl` | Human-origin persisted role + repo identity checks; ordinary resume separate; manifest fact never grants a role |
| Rules, provider stalls, readiness/completion distinction | `attention.rules`, `execution` | Exit/hook/blocker precedence, local classification, classification never writes input; a granted owning orchestrator may answer provider prompts (#629) |
