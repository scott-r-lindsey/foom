# Agent Schema

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
| ID | 1–40 lowercase ASCII letters/digits/hyphens, first letter; filename <id>.json; `shell`, `all`, `constructor`, `prototype` and bundled IDs (`claude`, `codex`, `agy`, `copilot`, `opencode`) reserved for config files |
| Text | 1–4096 Unicode code units unless narrower below; no Cc/Cf/Co/Cs or U+2028/U+2029; literal rendered text |
| Multiline template | <=16384 bytes each, LF and tab allowed; other hidden/control characters forbidden; aggregate template bytes <=32768 |
| Argv | <=64 nonempty Text entries; <=256 expanded entries/65536 bytes per process invocation, each expanded entry <=20480 bytes (prompt may contain LF/tab); no shell evaluation |
| Relative file | <=100 ASCII characters, <=4 components (fixed home metadata paths <=5); [A-Za-z0-9_.-]+ per component, no empty/dot/dotdot components, drive letters, absolute path, trailing dots or Windows device names; generated files forbid hidden components, metadata paths permit fixed hidden agent roots |
| Selector | `{source,path}`; source payload, header, probe, metadata, facts; path 1–8 literal keys (each <=64) or nonnegative integer indexes <=63; no wildcard, recursion or expressions |
| Condition | `{all?:[Test,...],any?:[Test,...]}` with 1–16 Tests total, no nesting; omitted all is true, omitted any is true; both present means AND of all-tests and any-test; `{all:[]}` alone means unconditional |
| Test | `{field,op,value?}`; field is a named fact or Selector; op eq, in, exists, absent, lt, gte; eq primitive, in <=16 primitives, numeric comparison safe integers only; exists/absent omit value |
| Local fact/case name | 1–40 ASCII letters/digits/underscore/hyphens, first letter; discovery facts cannot shadow engine or setup-derived facts. Unlike provider/channel IDs, these names allow uppercase letters |
| Fact condition | Tests refer only to engine facts or earlier declared discovery/setup/health facts; dependency DAG, no loops; missing/failed fact never satisfies eq/in/lt/gte |
| Argument matcher | One of `{flag,forms,value?}`, `{word}`, `{prefix}`, `{override}`; [matcher details](agent-launch.md#argument-and-environment-matchers); <=64 per list |

| Root field | Type / limits |
| --- | --- |
| kind, version | Required literals agent, 2 |
| id, name, badge, executables | Required ID, Text <=40, [A-Z0-9]{1,4}, 1–8 basenames <=64 [A-Za-z0-9][A-Za-z0-9_.-]* excluding .cmd/.bat/.ps1 |
| discovery | Required `{version?,facts}`; version `{prefix,suffixes,minimum?}`; prefix/suffixes Text or empty, <=4 suffixes, minimum three safe nonnegative integers; facts <=16 `{id,enabled?,minimum?,helpTokens?,when?}`; enabled boolean defaults true, false is a hard verification gate |
| launch | Required `{order,arguments?,display?,resume?,prompt?,guidance?,mcp?,toolPermissions?,environment?,model?,effort?,valueFlags?}` |
| files? | <=16 File records |
| hooks? | `{channels}`; 1–8 Channel records |
| reservedArguments, bypassArguments, bypassEnvironment | Required matcher arrays (may be empty); environment <=16 records |
| conversation | Required `{newId?,resumePin,restoreControl}`; newId optional `{format:"uuid",prefix?:Local fact/case name,arguments:Argv}`; resumePin first-event or requested-on-paste; restoreControl boolean |
| resumePaste | Required <=8 `{command,selector}` token patterns; command basename <=64, selector literal Text <=40; [paste details](agent-detection.md) |
| attention | Required `{minimumEngineVersion:1,rules,provenance?}`; rules <=64; provenance `{source,license,modified}` each Text <=256; inert, never fetched |
| execution | Required `{completion,completionChannels,providerRules?}`; completion attached or observed; channels <=8 IDs, providerRules <=16 rule IDs |
| health? | `{channel,requiredEvents,completionEvent,promptEvent,review,instructions}`; event arrays <=16 case IDs, instructions Text <=4096; review `{contains,lines,caseSensitive}` <=8 strings <=128, lines 1–40, boolean |
| setup? | `{status,actions,offer?}`; [status contract](agent-setup.md), actions <=8; offer `{unansweredLabel}` Text <=80 |

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

`launch.environment` accepts up to eight `{name,value,when?}` entries; see the
[per-launch environment bounds and security rules](agent-launch.md#per-launch-manifest-environment-636).

`launch.model` and `launch.effort` declare bounded selection templates and optional
value lists; effort requires a list. Optional `launch.valueFlags` lists up to 64
unique single-value option names, preserving literal argument ownership during
selection replacement. See [child model and effort](agent-launch.md#child-model-and-effort-853)
for the exact closed shape, token bounds, replacement semantics and bundled options.
