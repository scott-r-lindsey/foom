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
