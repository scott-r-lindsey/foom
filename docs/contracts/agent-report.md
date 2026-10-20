# Agent Report

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

### Saved screen-rule regressions (#592)

Config sessions can save their own probe viewport using
`foom agent probe screen <probe> --save working|blocked|idle|other`.
The label is the expected raw attention-rule state; `other` means an `unknown`
rule or no match. This corrects the issue's original acceptance wording: `done`
is not a screen-rule state. `--save done` is rejected with guidance to use `idle`
or `other`. Live evaluator behavior is unchanged.

Foom writes private, atomic, non-overwriting `captures/<agentId>/<label>-<n>.json`
files inside the config folder. Each holds schema version 1, agent ID and version,
expected state, screen lines, title, columns and rows. Captures contain screen
text, stay local, and are never uploaded or logged by Foom. New guides exclude
captures from the config folder's optional Git repository.

`foom config test-rules <agentId> [--json]` is credential-bound to a config
session. It tests saved captures against the currently loaded manifest's rules,
using the shared `evaluateScreenRules` and `ruleRegion` code called by the live
classifier's `detectAgent`, with the same priorities,
exclusions and evaluation budget. It prints expected and actual raw rule states
and the matched rule ID per capture, and exits 1 for any mismatch. No captures
produces an empty passing report. Invalid or unsafe captures fail the command.
Offline `foom config validate PATH` also reports failing captures for agent
manifests it validates; config-root validation includes bundled agent captures.
Screen text and titles are omitted from reports and diagnostics.

## Probe hook and MCP verification (#593)

Config sessions can run `foom agent probe events <probe>` using the same private
config-session credential as `config status`. Foreign, stopped and unknown probe
IDs are unreadable. This returns up to 128 hook observations and MCP booleans
`connected`, `listedTools`, and `pinged`. Each hook observation contains `channel`,
`event` (a safe extracted event name or null), `caseId` (accepted mapping case or
null), `paths`, and `sessionMatchesNewId`. Raw JSON values are discarded. Paths
are limited to depth four, 128 per event and 256 characters each; unsafe keys,
including controls and ambiguous separators, are omitted. Event names must be
ASCII identifiers of at most 64 characters. No hook payload is logged or persisted.

Only probe preparation temporarily enables disabled discovery facts. Version/help
requirements and other conditions still apply; normal launches keep their gates.
Declared hook channels and launch files can therefore be measured before setting
`hookVerified` or `mcpVerified` to true. `probe state` reflects accepted working,
ready, needs-input and failed hooks; completion hooks request screen classification.
Rejected session IDs and malformed events cannot change live state.

Each probe has a separate MCP listener and fresh credential. It exposes only `ping`,
never control or orchestration tools, including when invoked by name. Existing MCP
templates reference the probe credential through `FOOM_CONTROL_TOKEN`; this is not
a control grant. Successful initialization records connected, tool listing records
listedTools, and a successful ping tool call records pinged. Stop, exit, failed
preparation and config-session revocation revoke both hook and MCP capabilities.
No global agent settings are edited.

Drive a full lifecycle with the fixture/CLI, inspect events and state, and test
MCP tool listing/ping. Stop the probe, then enable only the facts actually verified
in the draft manifest, validate it and install it. Keep unverified facts disabled;
help output, a valid template or a screen alone does not verify delivery.
