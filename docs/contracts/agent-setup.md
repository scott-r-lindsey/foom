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
are selectable.

Probe output/metadata is untrusted; cases use facts derived from validated records,
not arbitrary evaluator expressions. A `plugin list --json` probe may declare `fallbackArguments: ["plugin", "list"]`; fallback runs only if the first command fails, never for malformed successful output or cancellation. Both calls retain the five-second/64-KiB limits. Probe JSON accepts the legacy `{imports:[...]}` object or a top-level array, normalizing the latter to imports. Each modern entry requires a boolean enabled field; only names and enabled switches survive validation. Duplicate target entries fail closed. Both forms validate an imports array <=64 and
entries with name Text <=64. Ownership requires real nonlinked expected directory,
manifest name/version and recognized observer identity. The engine derives facts
`owned`, `absent`, `disabled`, `version`: absent means no directory, manifest or list
entry; conflicting/unrecognized/invalid data => unavailable, never absent. Version
safe nonnegative integer; disabled uses the modern list entry when present, otherwise enabledField if present, else disabledField;
wrong types => unavailable. Metadata readers are read-only. The current generic reader accepts only
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
stdin program, retries or executable downloads. Hook commands use absolute paths into immutable staging, including quoted/encoded paths on Windows; session cwd never selects an observer. The content-addressed staging fingerprint covers expanded files with a normalized root and generated observer bytes; the concrete private staging root is expanded before review and verification. Staging must remain available for installed hooks, even when the CLI copies its files. Ownership may declare optional `unfingerprintedVersion` (ABI integer), accepting recognized versions at or above that floor only when the fingerprint is absent. An explicit fingerprint mismatch remains outdated. Observer plugins carry `foomStagingFingerprint` in CLI-owned plugin metadata; a changed definition is outdated and offers update even at the same ABI version. Staging verification rejects extra files, links and changed bytes before invoking the CLI. Stage files first for review;
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
