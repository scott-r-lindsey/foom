# Agent Setup

### Setup status and fixed actions

| Object | Closed fields / limits |
| --- | --- |
| status | `{probe?,metadata?,ownership?,cases,default}`; default unavailable; <=16 ordered `{when,state}` cases; state not-installed/installed/outdated/disabled/unavailable |
| probe | `{arguments,format,empty?,fallbackArguments?}`; fixed `plugin list` or `plugin list --json` Argv, format json; empty optional `{text,value}` exact text <=128 and bounded JSON value; timeout 5 s/output 64 KiB engine constants |
| metadata | <=4 `{id,path,optional}`; ID, home-relative Relative file, boolean; read JSON only <=64 KiB each |
| ownership | `{directory,manifest,require,versionField,currentVersion,disabledField,enabledField}`; home-relative directory, metadata ID, <=16 Requirements, Selectors; currentVersion 1–100000; disabledField optional Selector; enabledField optional Selector |
| action | `{id,label,kind,arguments?,instructions?,when,disclosure,statusProbe}`; ID, label <=40; kind command/instructions; exactly argv or instructions Text; disclosure Text <=4096; statusProbe fixed Argv for command or observed-health for instructions |

Setup status selectors may inspect validated metadata and the bounded probe
`imports[index].name` field, in addition to derived facts. No other probe fields
are selectable. The modern entry path is retained internally only for fixed install-location validation; it is never a selectable field or an executable.

Probe output/metadata is untrusted; cases use facts derived from validated records,
not arbitrary evaluator expressions. A `plugin list --json` probe may declare `fallbackArguments: ["plugin", "list"]`; fallback runs only if the first command fails, never for malformed successful output or cancellation. Both calls retain the five-second/64-KiB limits. Probe JSON accepts the legacy `{imports:[...]}` object or a top-level array, normalizing the latter to imports. Each modern entry requires a boolean enabled field; names and enabled switches are normalized; the untrusted install path is checked separately before use. Duplicate target entries fail closed. Both forms validate an imports array <=64 and
entries with name Text <=64. Ownership requires real nonlinked expected directory,
manifest name/version and recognized observer identity. The engine derives facts
`owned`, `absent`, `disabled`, `version`: absent means no directory, manifest or list
entry; conflicting/unrecognized/invalid data => unavailable, never absent. Version
safe nonnegative integer; disabled uses the modern list entry when present, otherwise enabledField if present, else disabledField;
wrong types => unavailable. Metadata readers are read-only. The JSON metadata reader accepts only
`<hidden-agent-root>/config/plugins/<name>/plugin.json` and the matching
`<hidden-agent-root>/config/config.json`; ownership.directory is the former file's
parent, and its required name is exactly `<name>`. This fixed layout bounds the
read facility; a new layout requires a reviewed schema change. Paths are disclosed exactly,
never exposed through arbitrary file IPC. Other home files (transcripts, secrets,
trust databases) cannot be selected. This reader facility is restricted to plugin
manifest and enabled-state metadata and does not weaken the no-transcript contract.

The current command grammar is `plugin install {pluginDir}`, `plugin enable NAME`,
or `plugin uninstall NAME`, with `plugin list` or `plugin list --json` as the status probe. The synthetic `plugin reinstall {pluginDir}` action is never passed to the CLI: it expands to `plugin uninstall NAME` followed by `plugin install {pluginDir}`, under one confirmation and ownership lock. Its guard is installed/outdated/disabled. The disclosure names both argv arrays and the reviewed staged files. Removal must verify absent ownership before install; the executable, staged bytes and cancellation are checked again. Failure leaves the actual CLI state for rescan, without rollback or automatic retry. NAME must equal
the ownership target; the selecting all-clause must restrict setupState to
not-installed/outdated for install, disabled for enable, or
installed/outdated/disabled for uninstall. Install also requires a plugin-scope JSON `plugin.json` whose name is exactly
the ownership target. Action IDs do not choose operations.
Other CLI mutation surfaces require their own reviewed architecture decision.

Command actions use the same resolved agent executable, fixed argv and only
{pluginDir}; no user/payload interpolation, subprocess choice, cwd selection, shell,
stdin program, retries or executable downloads. Hook commands use absolute paths into the CLI-owned installation, including quoted/encoded paths on Windows; session cwd never selects an observer. The content-addressed staging fingerprint covers expanded files with a normalized root and generated observer bytes; the concrete private staging root is expanded before review and verification. Installed hooks use the absolute canonical fixed ownership directory, not staging. The CLI copies the reviewed scripts there; deleting a disposable Foom profile therefore cannot delete an installed hook target. The normalization root identifies this installed-directory anchoring contract, so older staging-root definitions offer Update. Ownership may declare optional `unfingerprintedVersion` (ABI integer), accepting recognized versions at or above that floor only when the fingerprint is absent. An explicit fingerprint mismatch remains outdated. Observer plugins carry `foomStagingFingerprint` in CLI-owned plugin metadata; a changed definition is outdated and offers update even at the same ABI version. Staging verification rejects extra files, links and changed bytes before invoking the CLI. Stage files first for review;
serialize actions per executable/plugin ownership target, re-probe before/after,
re-read manifest bytes and recheck ownership after trusted confirmation. Conflicting
copies share the ownership lock, including case aliases on Windows/macOS. Failed commands report fixed errors and require
rescan, never assume success. Install only absent, update only recognized outdated,
enable only recognized disabled, remove or reinstall only recognized installed/outdated/disabled.
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

### Installed observer health and profiles (#723 review)

Before reporting an observer plugin installed, status validates a modern list entry path as a bounded string without controls, matching the exact native spelling of either the fixed home-relative ownership location or its canonical spelling. Dot/parent segments, repeated or trailing separators, and alternate separator spellings are rejected without lexical normalization. Case variants qualify on Windows and macOS only; Linux requires exact case. Every qualifying spelling, including a home alias such as macOS `/var` versus `/private/var`, must resolve both sides with `realpath` and match filesystem device/inode identity with the fixed owned directory. Comparing identities also handles `realpath` preserving case on case-insensitive volumes. This also rejects case variants that identify different directories on a case-sensitive filesystem. Reported paths never select inventory reads and are never executed. Legacy probes use the same fixed ownership location without a reported path. Status reads only the declared plugin file inventory and generated observer assets under that location, with bounded descriptor reads, component identity checks, and no links. Apart from separately validated CLI-owned plugin metadata, bytes must exactly match the generated definition anchored to the canonical installed directory. Missing scripts, changed hook commands, and unsafe inventory reads make a recognized installation outdated, preserving reviewed Update/Reinstall and Remove. Missing, noncanonical, or foreign modern install paths and unknown ownership are unavailable.

No documented agy plugin-root variable is assumed. The absolute installed location survives Foom profile deletion; no shared external cache or agent configuration write is needed. Foom Dev, everyday, and disposable profiles with the same definition and agent home generate identical installed commands and accept the same bytes. Scans do not rewrite the plugin or make either profile adopt its own staging root. Different definitions legitimately offer Update; changing one requires explicit confirmation. The normalized fingerprint identifies the definition, while installed-byte validation establishes target presence and anchoring.
