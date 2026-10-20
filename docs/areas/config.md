# Config

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/settings.md).

Config-session launch and probe-credential plumbing live in `main/workspace/sidebar-commands.ts`, bound by `workspace-context.ts`. The public Workspace facade grants no additional config capability.

## Foom config environment (#84)

`~/.foom/config` is the agent-editable configuration folder. It is not Electron's
userData: API keys, worktree ownership, the repository list and
consent records stay in the profile. The folder holds `settings.json`, `themes/`,
`terminal-themes/`, `sounds/{working,done,needs-you,refusal}/`, and Foom-owned
`README.md`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `examples/` (a strict JSON v2
agent starter with field notes) and `schemas/` (settings, both theme formats and
v2 agents, derived from shared validators). Config shells use the discovered
login-shell PATH, as agent launches do; the bundled config CLI directory stays
ahead of user Environment entries and that PATH. Foom writes
its files at first launch and replaces one on upgrade only when it is missing or
byte-identical to a version Foom shipped earlier (`OWNED_HISTORY`), so user edits
survive. Guide edits append the new digest to `tests/fixtures/config/guide-digests.json`
and retain every earlier digest in all three guide entries in `OWNED_HISTORY`;
the layout unit test enforces this. The folder is plain files (#540): Foom never creates, reads or writes a
`.git` there, and leaves an existing one untouched. `.gitignore` excludes recordings
under `sounds/` and keeps `.gitkeep` files, for users who keep the folder in their
own repository. `WorktreeService` refuses to register a
repository that is, contains or sits inside the folder, checking before it runs any
git command there. The check is installed before saved repositories load, so a
conflicting saved registration is dropped, and config sessions refuse to start if a
registered repository contains the folder. `foom config validate` skips the Foom-owned entries and `.gitkeep`.

**Settings.** The allowlisted keys from #206 live in `config/settings.json`. On the
first launch with a version 1 profile, main writes them into a new `settings.json`
(an existing file wins and the profile values are dropped), then rewrites the
profile as version 2 without them in the same step. Values the file cannot express,
such as portable palette objects, fall back to the default. A version 2 profile
stores only profile settings plus `configDigest`, the SHA-256 of the settings file
this profile last applied, and `configText`, a copy of that file (at most 64 KiB)
so Keep it on can restore it after a restart. If the folder cannot be prepared, settings stay in the
version 1 profile and migration is retried at the next launch. On upgrade from either profile version, nonempty validated per-agent launch
arguments move once into settings.json when its key is absent. Invalid profile
lists retain the existing per-agent drop rule. The migration trusts only the
profile arguments, preserves other file holds, and records a recoverable approved
baseline before removing the profile copy. A failed migration retains the profile
copy for retry. An existing argument key remains a file proposal, compared against
the migrated profile defaults. Empty profile defaults leave the key absent.
Settings saves split
the patch: config keys are written to the file atomically and applied; profile
keys go to the profile. On Windows only, atomic
replacement retries EPERM/EBUSY up to five attempts with 25, 50, 100 and 200 ms
backoff for transient external sharing locks. It never unlinks the destination;
exhaustion removes the temporary file, reports a fixed error naming the config
file, and retains the existing file, applied values and pending approval.

**Live reload.** Main watches `settings.json`, `themes/` and `terminal-themes/`,
waits 250 ms after the last event and scans serially. When `themes` or
`terminal-themes` is replaced, the root watcher resubscribes to it. Reads refuse
links, nonregular files and files over 64 KiB; a theme folder that is a link or
resolves elsewhere is refused for reads, writes and removals, so nothing outside the
folder is read or deleted. `settings.json` is compared with the text Foom last
applied. Settings use the #206 parser and theme files the #205 parser; an invalid
file is rejected whole with a filename, JSON path and fixed reason, and the last
good version stays in effect. A valid settings change applies live; the theme
library applies theme additions, edits and removals through its own watcher.
Sound catalogs still refresh when Settings → Sound opens.

**Approval.** A change is held instead of applied when, compared with the effective
settings in force, it turns alerts off, sets the alert volume to 0, turns hooks off,
or turns an agent off, enables restoreSessions, or changes any agentArguments list. A missing key means the default. Sizes and turning things on apply without approval. Theme changes follow the
attention-distinctness hold described below. Settings → Foom config
and the config footer dock show the held change in amber. The held change carries an ID,
the digest of its text, and a decision must name it: if an agent replaced the
proposal after the banner was shown, the decision is refused and the new one shown.
**Allow** rechecks that the file still has the held content and applies it. **Keep it on** writes back the
last applied text. At startup the working file is trusted only if its digest
matches `configDigest`; otherwise the profile's `configText` is trusted if its
digest matches; otherwise the baseline is the defaults (`{ "kind": "settings" }`),
so an off switch written while Foom was closed is held and Keep it on restores a
valid default file. A Settings save replaces a held change. Every file argument change holds,
regardless of known bypass detection. Allow opens the existing main-owned trusted
dialog containing literal before/after lists and known bypass flags, then rechecks
the proposal bytes before applying. Accepted bypass changes persist per-agent
acknowledgement in the profile. Argument text never enters board status metadata.
Settings UI edits use the config writer directly and retain their bypass dialog.

**Status.** Settings → Foom config shows the folder, **Open folder**, and only
what needs the user now: a held change, or each rejected file with its fixed
reason. There is no change history (#540).

**Sessions and IPC.** The board's Foom config footer panel runs agents and shells in the
folder: no worktree, no repository-scoped control grant, the usual per-launch hooks
and evaluator, the same Environment layers as other sessions, and the bundled
console directory first on `PATH`, ahead of Environment entries, even if the CLI was
never installed. A new agent config session receives a fixed, main-only greeting
that asks what the user wants to change; resuming a conversation adds no greeting.
Antigravity receives it only when interactive prompts are supported, preserving
any user default prompts. `config-launch` carries no prompt.
Every config launcher action starts a new session, including while another launch
is starting or a session is running. Concurrent writes use the config service’s
validated, serialized writer. Resume targets only the selected conversation.
Session records keep a validated `config` flag (folder path equal to itself, no
branch) and restore every session for the current folder. Sidebar commands
`config-launch` (a run kind and optional menu origin) and `copy-config-path`
carry no paths.
`config:status`, `config:decide` (`allow` or `keep` with the held change's digest)
and `config:open-folder` check the trusted top frame and exact argument counts; main pushes `config:changed`. File contents, raw parser messages and
absolute paths other than the folder itself never reach the renderer. The folder
never holds secrets; Foom sends nothing from it to any network service.

Saved probe viewports live in private `captures/<agentId>/` files when requested by a config session. New guides exclude captures from optional user Git history; Foom never uploads them. [Capture/replay and offline validation](../contracts/agent-report.md#saved-screen-rule-regressions-592) govern their use.
