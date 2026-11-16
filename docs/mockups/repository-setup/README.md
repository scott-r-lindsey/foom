# Repository setup (#1080) — phase 1 proposal

**Awaiting user approval; unimplemented.** The [design](../../design/1080-repository-setup.md)
is the proposed behavior/security authority for this mockup. Existing area docs
remain the authority for shipped behavior. No setup, process launch or profile
write is performed here. This new reference is explicitly requested by #1080;
existing mockups remain untouched.

Open [index.html](index.html) in a browser or serve the repository root with a local
static server. Local bundled Geist fonts work offline. No remote assets are loaded.
The mockup uses fixture data; its abbreviated package list is not a working setup
recipe for Foom. Toolchain previews deliberately label their pinned-helper steps
as summaries; implementation must expose exact version, address, checksum and argv.

Use `?theme=light` or `?theme=dark`, plus `&scene=hosts` (default). The top strip is
review chrome, not app UI. Scene and theme selectors do not contact a host.

| Scene | Review |
| --- | --- |
| `hosts` | Host Ready remains separate from repository Needs setup; missing items, revision, Review list, single Set up click and row reload. |
| `empty` | Write a list or copy a draft brief for an ordinary agent; paste an untrusted suggestion, then review. No new agent permissions. |
| `review` | All distro mappings, toolchains, evidence, command preview and Approve list distinct from execution. |
| `stale` | Source/version change blocks setup and new launches; return to an editable draft. |
| `running` | Embedded human-owned setup terminal; password input belongs here. Stop and illustrative success/failure controls. |
| `failed` | Failed step and exit code, subsequent steps skipped, scoped recheck still unmet, explicit retry. |
| `met` | Requirements met after recheck, independent of build success and the full-check timestamp. |
| `launch` | Refusal before spawning a child, bounded missing items and Open setup; no automatic retry. |
| `unsupported` | Manual setup with a reason and no Set up button. |

Click Review list → Approve list → Set up → Simulate failed step → Set up →
Simulate success to inspect the primary flow. Scene controls also allow direct
comparison of freshness, launch refusal and an unconfigured repository. Buttons
change illustrative scenes only. Import parsing, editing, actual agent selection,
validation and source-diff inspection are described in the design, not implemented
in this reference. Copy draft brief writes only that fixed brief to the clipboard
on click. Other inactive app chrome is disabled. Keyboard focus has visible rings;
status uses words and shapes as well as brand colors. Narrow layouts hide reference
navigation and wrap cards instead of scrolling horizontally.

## Evidence

Capture screenshots outside Git under `test-results/1080/`. Required pairs are
`hosts-light.png` / `hosts-dark.png` and `review-light.png` / `review-dark.png`;
also capture stale, failed, met and launch in both themes, plus a narrow layout.
Screenshots are review evidence, never committed or embedded using repo-hosted image
links. The phase-one handoff supplies absolute evidence paths and the draft PR.
User approval and merge of the design precede runtime implementation.
