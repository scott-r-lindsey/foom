# Config

**Data architecture transition (#1153):** [Data ownership](data.md) defines the
decided SQLite/Drizzle and subscribed-view target. Phase A (#1160) changes docs
and an isolated spike only; current stores and channels described here remain
in production until phases B–D migrate them.

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/settings.md).

Config-session launch and probe-credential plumbing live in `main/workspace/sidebar-commands.ts`, bound by `workspace-context.ts`. The public Workspace facade grants no additional config capability.

## Foom config environment (#84)

`~/.foom/config` is the agent-editable configuration folder. It is not Electron's
userData: encrypted Environment secrets, worktree ownership, the repository list
and consent records stay in the profile; legacy inference keys are
[deleted on load](privacy.md#secrets). The folder holds `settings.json`, `themes/`,
`terminal-themes/`, `agents/`, `forges/`, `sounds/{working,done,needs-you,refusal}/`,
private saved probe `captures/`, and Foom-owned
`README.md`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `examples/` (a strict JSON v2
agent starter with field notes) and `schemas/` (settings, both theme formats and
v2 agents, derived from shared validators). Config shells use the discovered
login-shell PATH, as agent launches do; the bundled config CLI directory stays
ahead of user Environment entries and that PATH. Foom writes
its files at first launch and replaces one on upgrade only when it is missing or
byte-identical to a version Foom shipped earlier (`OWNED_HISTORY`), so user edits
survive. Guide edits append the new digest to `tests/fixtures/config/guide-digests.json`
and retain every earlier digest once in `GUIDE_HISTORY`, shared by all three
`OWNED_HISTORY` guide entries;
the layout unit test enforces this. The folder is plain files (#540): Foom never creates, reads or writes a
`.git` there, and leaves an existing one untouched. `.gitignore` excludes recordings
under `sounds/` and keeps `.gitkeep` files, for users who keep the folder in their
own repository. `WorktreeService` refuses to register a
repository that is, contains or sits inside the folder, checking before it runs any
git command there. The check is installed before saved repositories load, so a
conflicting saved registration is dropped, and config sessions refuse to start if a
registered repository contains the folder. `foom config validate` skips the Foom-owned entries and `.gitkeep`.

Development launchers `start:fresh`, interactive `start:samples`, and `start:hosts`
pass the value-free `--foom-isolated-state` switch. In an unpackaged app this derives
both the config and managed worktree roots from `<userData>/.foom/`, without
accepting an arbitrary path. A switch value is rejected; packaged builds ignore
the switch. `start:fresh` owns a temporary profile and removes all this state on
exit (unless `--keep`); samples and hosts use the persistent Foom Dev profile.
Screenshot capture already owns a fixture HOME and temporary profile. Ordinary
launches continue to share `~/.foom/config` and `~/.foom/worktrees`.

**Settings.** The allowlisted keys from #206 live in `config/settings.json`.
Provider-ID keys in `agents` and `agentArguments` are optional: absence means
disabled or no extra arguments. Existing explicit entries are retained without
filling other provider keys. See [profile downgrade recovery](settings.md#settings-and-setup)
for the private one-time backup retained before profile migration. On the
first launch with a version 1 profile, main writes them into a new `settings.json`
(an existing file wins byte for byte and the profile values are dropped).
Fresh, corrupt, and version 2 profiles without an applied baseline likewise adopt
an existing file through the ordinary external-edit apply and hold path. Adoption
grants no approval: off switches, argument changes and attention-conflicting theme
selections still hold against defaults. Creating a missing file atomically refuses
to replace one another profile created concurrently. Legacy window scale is included
in the initial no-clobber file creation; there is no later startup Settings save.
A concurrent replacement during baseline persistence is scanned as an external
edit and cannot be overwritten by migration. After initialization, main rewrites
the profile as version 2 without config settings. Values the file cannot express,
such as portable palette objects, fall back to the default. A version 2 profile
stores only profile settings plus `configDigest`, the SHA-256 of the settings file
this profile last applied, and `configText`, a copy of that file (at most 64 KiB)
so Keep it on can restore it after a restart. Main persists the digest and copy
in one atomic profile replacement, along with the digest of a newly selected
custom palette when available. If the folder cannot be prepared, settings stay in the
version 1 profile and migration is retried at the next launch. For profiles with a
verified applied config baseline, nonempty validated per-agent launch arguments
move once into the recoverable approved baseline before the profile copy is removed. Invalid profile lists retain the existing per-agent drop
rule. Migration never rewrites an existing working settings file, including one
without an argument key: that file remains an external proposal compared against
the migrated profile defaults. A missing argument key is an argument removal and
holds through the ordinary approval path; Keep it on restores the approved
arguments, while Allow accepts the removal. Other file holds remain intact. A
failed baseline migration retains the profile copy for retry. A newly created
settings file includes the profile arguments directly; empty profile defaults
leave the key absent.
Settings saves split
the patch: config keys are written to the file atomically and applied; profile
keys go to the profile. Settings saves acquire an exclusive
`.foom-settings.lock` file shared by all profiles before reading, validating and
merging only the patched keys into the current settings file, and hold it through
atomic replacement. Contention waits at most 20 intervals of 25 ms, then refuses
the save; the caller can retry the unchanged patch. No stale-baseline fallback is
allowed. The lock is published exclusively by hard-linking a complete, fsynced private
temporary file in the same directory, on Windows as well as POSIX. A filesystem
that refuses hard links refuses the save; it never falls back to publishing an
empty lock. Before entering the critical section, the owner rechecks its token
at the lock path. The lock records its owner's PID, Linux boot/start identity when available,
hostname, random token and timestamp. Same-host owners are recovered only after
ESRCH or a mismatching start identity proves death or PID reuse. Recovery uses an
exclusive recovery lock and rechecks the stale record before removing it; crashed
recovery locks use the same protocol (up to four nested recovery locks, then fail
closed). Release removes only a matching token. Live owners and foreign-host
records never expire. Unreadable, linked and nonregular locks fail closed.
Readable corrupt records also fail closed at any age: atomic publication means
a crash while writing the record leaves only an unpublished temporary file.
There is no longer a need for the 24-hour corrupt-record recovery rule, which
could steal a live, paused writer's lock after a clock jump. Legacy corrupt locks
require manual removal while all sharing apps are stopped. Settings failures use
fixed typed codes: `settings-busy` asks to try again, `settings-lock-corrupt` asks
to quit other Foom windows and remove `.foom-settings.lock` and its recovery locks,
and `settings-lock-unsupported` explains that the config filesystem does not
support hard links. No filesystem path or exception text crosses IPC.
Lock publication cleanup retries EPERM/EBUSY five times with 25, 50, 100 and
200 ms backoff, then logs and leaves the temporary file without discarding
ownership. Later acquisitions sweep complete `.foom-*.tmp` lock records only
when the same-host process is proven dead by the lock recovery rules; other
config temporaries and live, foreign or unverified owners remain untouched.
Safe external edits are adopted through the approval gate. With a verified
baseline, a save applies safe preferences from the current file and the Settings
patch. Unrelated held changes remain on disk and pending. Without a trusted baseline (including rejected profile loads),
a held file refuses Settings saves until reviewed. Missing, unreadable or invalid
files also refuse saves without replacing external bytes. Allow and Keep it on
use the same lock to verify the proposal before applying or replacing it.
Settings writes use compact JSON when pretty printing would exceed 64 KiB.
The [#1234 investigation](../research/settings-reset-1234.md) records both
reproduced races and recovery limits; it does not establish the historical
incident trigger. On Windows only, atomic
replacement retries EPERM/EBUSY up to five attempts with 25, 50, 100 and 200 ms
backoff for transient external sharing locks. It never unlinks the destination;
exhaustion removes the temporary file, reports a fixed error naming the config
file, and retains the existing file, applied values and pending approval.

`config/service.ts` keeps approval baselines, held settings and theme changes, trusted argument disclosure, and decision revalidation together. `config/files.ts` owns bounded reads, directory containment and atomic replacement; `config/catalog.ts` owns theme path discovery and agent and forge manifest discovery, validation and reload.

**Live reload.** Main watches `settings.json`, `themes/` and `terminal-themes/`,
waits 250 ms after the last event and scans serially. The initial Settings
review and writer attachment use the shared lock. With a busy lock, the board
opens on the verified baseline and attachment retries. If attachment fails,
live scans resume under the Settings lock. Shutdown cancels any pending
attachment and fences its profile commit. The saved-session pass
uses the attached Settings values through the [startup coordinator](sessions.md#startup-and-quit-1284).
Live Settings reviews also use the shared lock. If a live scan times out waiting for that lock, the watcher
retries it in the background. When `themes` or
`terminal-themes` is replaced, the root watcher resubscribes to it. The config
scanner (`config/files.ts`) refuses file links, nonregular files and files over
64 KiB; [offline validation](console.md) also rejects in-folder links. The separate
[theme library](themes.md#custom-theme-files-205) resolves named entries and accepts
a file link only when its target is directly in the same theme folder. Both reject
linked or redirected theme folders; reads, writes and removals cannot escape them.
`settings.json` is compared with the text Foom last applied. Settings use the #206 parser and theme files the #205 parser; an invalid
file is rejected whole with a filename, JSON path and fixed reason, and the last
good version stays in effect. A valid settings change applies live; the theme
library applies theme additions, edits and removals through its own watcher.
Sound catalogs still refresh when Settings → Sound opens.

**Approval.** A change is held instead of applied when, compared with the effective
settings in force, it turns alerts off, sets alert or master volume from positive
to 0, turns master mute on, turns hooks or an agent off, enables restoreSessions,
or changes any agentArguments list. See the [user-visible hold rules](../behavior/settings.md#foom-config). A missing key means the default. Sizes and turning things on apply without approval. `showNewChildren` is a display preference and applies without approval in either direction: it changes placement only, leaving attention and permissions intact. Theme changes follow the
attention-distinctness hold described below. Settings → Foom config
and the config footer dock show the held change in amber. The decision ID binds
the proposal's settings bytes and any custom palette involved in a selection
change. An active palette edit also binds the working Settings file. If either
input changes, the decision is refused and main refreshes the review.
**Allow** applies the verified snapshot. **Keep it on** restores only held
fields, preserving safe changes from the shared file. If restoring held provider
toggles would exceed the provider map limit, Keep it on retains the approved
provider map. If the merge or the defensive fallback with the previous palette
exceeds 64 KiB even as compact JSON, Keep it on restores the full approved file
and reports that the other edits were dropped. At startup the working file is
trusted only if its digest matches `configDigest`; otherwise the profile's
`configText` is trusted if its digest matches; otherwise the baseline is the defaults (`{ "kind": "settings" }`),
so an off switch written while Foom was closed is held and Keep it on restores a
valid default file. A Settings save preserves unrelated held keys; an unverified baseline refuses the save. Every file argument change holds,
regardless of known bypass detection. Allow opens the existing main-owned trusted
dialog containing literal before/after lists and known bypass flags, then reacquires
the lock and rechecks both the settings and palette before applying. Accepted bypass changes persist per-agent
acknowledgement in the profile. Argument text never enters board status metadata.
Settings UI edits use the config writer directly and retain their bypass dialog.
Each argument editor submits only its provider's list, which main merges under
the shared lock. A manifest reservation masks a saved list at runtime while
preserving the approved bytes for later use.

**Status.** Settings → Foom config shows the folder, **Open folder**, and only
what needs the user now: a held change, or each rejected file with its fixed
reason. There is no change history (#540).

**Sessions and IPC.** The board's Foom config footer panel runs agents and shells in the
folder: no worktree, no repository-scoped control grant, the usual per-launch hooks
and evaluator, the same Environment layers as other sessions, and the bundled
console directory first on `PATH`, ahead of Environment entries, even if the CLI was
never installed. Supported agents also receive a separate, manual-only MCP attachment
with no repository or session authority; see [MCP](mcp.md#bundled-manual-699).
A new agent config session receives a fixed, main-only greeting
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
