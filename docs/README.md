# Documentation

Start with the repository [quick start](../README.md), then [AGENTS.md](../AGENTS.md)
and the [file map](map.md). The map names source owners and the short area rules
and behavior to read before a change. Read protocol sections only when changing
that surface; a terminal fix does not require reading all settings or control docs.

## Authority and maintenance

| Question | Authority |
| --- | --- |
| Who owns a file or capability, and what should I read? | [File map](map.md) |
| What should the user experience? | [Area behavior](product.md) → `behavior/` |
| Which process owns it and what must it validate? | [Area implementation rules](architecture.md) → `areas/` |
| What are the detailed wire formats? | [Agent manifests](agent-plugins.md), [control plane](orchestration.md) → `contracts/` |
| How must contributors implement, test and deliver? | [AGENTS.md](../AGENTS.md) |
| How do local tools and CI work? | [Development](development.md), [validation](validation.md), [Electron sharding](electron-shards.md), [fixtures](electron-fixtures.md) |
| What are the color, type and theme rules? | [Brand](brand.md) |
| How do I open unsigned nightly builds? | [Nightly opening](nightly-opening.md) |

Keep a fact in its owning area and link to it. Entry points are navigation, not
additional policy. Behavior owns product decisions; implementation rules own
process/security decisions; detailed contracts own protocol fields. Research and
mockups cannot override a decided rule. A changed decision needs its own PR and
matching docs. Correct a stale description against source/tests without silently
recasting an apparent implementation defect as intended behavior.

Area rules and behavior describe current decisions. Explicitly labelled proposed,
target or future material is unimplemented and must name an issue. Required area
reading should stay a few hundred lines; split by responsibility rather than
appending migration diaries. Put dated versions, measurements, payload captures,
test counts and migration history in the issue or implementation PR, with a link
from the relevant rule. Evidence does not establish cross-platform support beyond
its recorded run. The former monoliths retain navigation anchors for old links.

## Research and read-only references

[Agent signal evidence](agents.md) links issue records. [Agent marks](agent-marks.md),
[activity traces](activity-trace.md), [preview spike](previews.md),
[agent preview spike](agent-previews.md), [editing](editing.md),
[Herdr experiment](herdr-backend.md), and [board investigation](board-startup-investigation.md)
are historical findings, not required area reading. [Forge manifests](forge-plugins.md)
contain a staged specification: use [current forge ownership](areas/forge.md) for
activation status. [Copilot](research/copilot-manifest.md) is an unverified draft,
with [verification gates](research/agent-verification.md), not a supported agent.
[Child follow-up](research/child-follow-up.md) is superseded for PTY input by #629;
[remote machines](research/remote-machines.md) remains proposed.

[Mockups](mockups/README.md), `../inspiration/` and `../spikes/` remain references.
Do not edit mockups or inspiration while implementing an area change.
