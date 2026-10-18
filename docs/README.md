# Documentation map

Start here after the repository [quick start](../README.md). Read
[AGENTS.md](../AGENTS.md) before contributing, then [product](product.md) for the
user experience and [architecture](architecture.md) for process and security rules.
For a UI change, also read [brand](brand.md) and the matching
[mockup README](mockups/README.md).

## Authority and maintenance

| Question | Authoritative document |
| --- | --- |
| What should the user experience? | [Product](product.md) |
| Which process owns a capability, and what must it validate? | [Architecture](architecture.md) |
| How must contributors implement, test and deliver changes? | [AGENTS.md](../AGENTS.md) |
| How do local build tools and commands work? | [Development](development.md) |
| How does CI validate and package the app? | [Validation, CI and packages](validation.md) |
| How are Electron suites, shards and fixtures organized? | [Electron layout/sharding](electron-shards.md), [fixtures](electron-fixtures.md) |
| What are the interface color, type and theme rules? | [Brand](brand.md) |
| What is the control-plane protocol? | [Orchestration](orchestration.md), with implementation ownership in [architecture](architecture.md#control-plane) |
| What can agent manifests express? | [Agent plugin format](agent-plugins.md), with loading/trust in its [trust model](agent-plugins.md#trust-model) |
| How do I open an unsigned nightly? | [Nightly opening](nightly-opening.md) |

Keep each fact in the document that owns it and link from summaries. README is
orientation, not a second policy manual. AGENTS.md owns contributor requirements;
the development and validation guides explain their tooling. Product owns behavior,
architecture owns implementation/security decisions, and detailed protocol docs
own wire formats and feature contracts. These responsibilities complement each
other; a protocol or research note cannot override a product or security decision.

Implemented claims should agree with source, tests and configuration on the branch.
If they disagree, check the implementation before correcting the documentation.
A change to an established product/security decision needs its own PR and matching
doc updates; an apparent code defect should be reported rather than silently
recast as intended behavior. Keep links and entry-point summaries current when
moving material. Future changes belong under an explicit **Proposed**, **Target**
or **Future** label and an issue, rather than an unqualified present-tense claim.

## Architecture entry points

Architecture retains the core rules and feature details at their existing anchors:

- [Profiles](architecture.md#application-profiles), [process model](architecture.md#process-model), [source layout](architecture.md#source-layout) and [security defaults](architecture.md#security-defaults).
- [Renderer](architecture.md#renderer), [terminal host](architecture.md#terminals), [IPC contract](architecture.md#ipc-contract) and [confirmations](architecture.md#confirmations).
- [Worktrees](architecture.md#worktrees), [agent launch](architecture.md#agent-discovery-and-launch), [control plane](architecture.md#control-plane) and [saved conversations](architecture.md#saved-conversations).
- [Settings](architecture.md#settings-and-setup), [config folder](architecture.md#foom-config-environment-84), [theme files](architecture.md#custom-theme-files-205), [sounds](architecture.md#recorded-sounds) and [previews](architecture.md#previews).
- [Evaluator](architecture.md#evaluator-pipeline) and the short [local classification overview](inference.md).

## Current behavior, proposals and evidence

Product and architecture describe established decisions and implemented behavior
unless a passage explicitly marks a target or future change. Orchestration combines
an implemented protocol with evidence and a clearly labelled proposed child
follow-up channel. Agent plugin v2 parsing, launch, hooks and setup are implemented;
its Copilot examples and forge extension remain drafts with shipping gates.

The following are evidence or proposals, not current feature specifications:

| Material | Status and current reference |
| --- | --- |
| [Agent signals](agents.md) | Dated CLI measurements plus integration notes; use architecture for current launch/restore policy |
| [Agent marks](agent-marks.md) | Dated vendor research; current badge presentation is in product |
| [Preview spike](previews.md), [agent preview spike](agent-previews.md) | Historical prototype findings; shipped behavior is in product and architecture |
| [Editing](editing.md) | Research and proposed follow-ups; no built-in editor contract |
| [Herdr backend](herdr-backend.md) | Not adopted; retained decision and experiment record |
| [Board startup investigation](board-startup-investigation.md) | Dated diagnostics and open investigation, not a workaround policy |
| [Forge manifests](forge-plugins.md) | Proposed specification; implementation requires the recorded product decision |
| [Child follow-up](research/child-follow-up.md) | Proposal only; the current reviewed-reply gate remains in orchestration |
| [Remote machines](research/remote-machines.md) | Proposed architecture and prototype evidence; no shipped remote host |
| [Mockups](mockups/README.md) | Read-only layout/interaction reference; product and architecture win on disagreement |
| `../spikes/`, `../inspiration/` | Prototype evidence and read-only external reference, respectively; neither is application code |

Measurement versions and historical test counts describe their recorded runs, not
promises about current releases. Preserve that evidence; add a status note and link
to current behavior when later implementation supersedes a recommendation.
