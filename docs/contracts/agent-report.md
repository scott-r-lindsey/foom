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
