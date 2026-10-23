# Settings

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

## Settings

Settings → Foom config explains that the folder contains plain files watched and
validated by Foom. You can edit them yourself or launch an agent from the sidebar’s
Foom config entry. Invalid files are rejected and the last good version stays.

Settings opens on **General** unless an entry point targets a specific section.
General offers **Show repository paths relative to code folder**, off by default.
When on, sidebar repositories beneath the chosen code folder show relative paths
(such as `work/foom`); repositories outside it keep their names.

Open **Settings** from the board, or press ⌘, on macOS and Ctrl+Shift+, elsewhere.
It replaces the terminal tiles beside the persistent sidebar in the same window.
Esc returns to the tiles and restores the same focused sidebar row.
Selecting a terminal in the sidebar also leaves Settings; terminals keep running throughout.

General offers **Show pull requests and checks**, defaulting to on when an enabled forge for a selected repository is ready during first run. The [shared forge disclosure](orchestration.md#orchestration-and-privacy) explains the selected CLI login and read-only metadata requests. Turning it off stops non-orchestrator polling. Foom stores no tokens and makes no forge writes.

General offers **Restore sessions on launch**, on by default. Turning it on through agent-edited config requires Allow because it also permits restoring orchestrator control. General also offers **Auto-remove merged worktrees**, off by default and applying to all repositories.

General also offers **Show new children on the board**, on by default. It applies
to new orchestrator child launches only; existing tiles and restored children stay
as they are. Off keeps new children in the sidebar, where they retain attention
and can be opened normally. The config-folder key `showNewChildren` is a plain
display preference and applies without Allow in either direction.

Forges shows bundled and config manifests in the same card layout, with an On/Off
switch, badge and host assignments. Valid config manifests load without
approval; there is no Duplicate action. Copies start off with no hosts. Settings
saves exact lowercase DNS hostnames against an enabled forge; manifests cannot
assign hosts. GitHub defaults to `github.com`. Disabling preserves assignments.
These preferences control production routing and polling. Disabling a forge stops
its probes/polls and retires observations; declarations cannot claim hosts. Cards show declared executables. A shared host list shows Ready, Not installed,
Not signed in, Unable to check or PR status unavailable, using only hosts from
registered repositories. Recheck uses the same auth-status checks as first-run
T-0 and discloses possible CLI network access. Sign-in commands are displayed,
never run. Requests resolve native executables through the main-owned lifecycle.

General offers Foom’s folder or a location next to each repository for new worktrees, with an example
destination. Changes apply to future creation; existing worktrees stay where they are.

Agents and Repositories use the same controls as preflight. Agents shows one central-column card per provider, including config
plugins, and plugins rejected by validation. A missing installation is one
line with a disabled Off switch and “Not found”; its saved preference is retained.
Opening Agents or loading or reloading a manifest refreshes discovery. Once the
executable is found, the switch follows the saved preference. Every installed
agent has an On/Off switch. Off removes the agent from launch menus
and CLI discovery probes while retaining its defaults, environment and attention preferences.
To customize a built-in agent, copy its bundled manifest into the config folder's
`agents/` folder with a new ID and name (see [agent plugins](../contracts/agent-trust.md#customizing-a-built-in-agent)).
Settings offers no action for it. Like any valid config plugin, the copy loads as
soon as Foom reads it. Both built-in and copy can remain on, or the built-in can be turned off.
Each installed agent's card groups attention, capability chips, default
arguments and its environment editor. Hooks/Screen rules
appears only for agents with hook support; the global Attach hooks switch still
wins. Per-agent attention preferences apply to future launches. Changes apply immediately and persist. A repository scan in Settings
starts with the already-added repositories checked; toggling a selection saves it
at once and reports any refusal.
When agy is detected without its plugin and the user has never answered the offer,
Settings → Agents shows a neutral **Plugin available** marker. There is no
launch modal or toast. Answering the install confirmation, including **Not now**,
persists the answer and clears the marker; the inline action stays available.
Without agy on PATH, no plugin controls or marker appear.

An owned Antigravity plugin offers **Reinstall plugin** and **Remove** while
installed, outdated or disabled. Reinstall confirms both steps together, then
uninstalls and installs the reviewed observer. If installation fails after removal,
scan again and use Install. Outdated installations also offer Update; disabled
installations offer Enable. **Status unavailable** offers **Retry status** in the
row and no mutation actions until a successful check establishes ownership.

Settings → Agents also provides default launch arguments for each supported
agent, one argument per line, saved when focus leaves the editor. Put flag
values on separate lines. Spaces and quotes are literal, with no shell parsing or
splitting. LF and CRLF are accepted; trailing blank lines are ignored. Errors name
the agent and line. An empty editor uses the existing launch behavior. The user's agent policy
is their global config plus Foom defaults; Foom appends its own display and attention
flags and never edits global config. Defaults affect future user launches only.

Main validates at most 64 arguments per agent, each 1–4096 characters with no control
characters. Foom reserves Claude `--settings`, `--safe-mode` and `--bare`,
`--no-alt-screen`, Codex `-c`/`--config` overrides of `notify` or `hooks`, and the `--` terminator so
these defaults cannot displace its attention flags. Saving a known bypass argument
requires a main-owned trusted dialog once per agent, with Cancel focused by default: a worktree is not a sandbox, and
the agent can act as the user anywhere on the machine. Cancelling leaves settings
unchanged. Codex `danger-full-access` sandbox flags and `sandbox_mode` overrides
also count as bypass, even with approvals enabled. Known bypass detection is a
fixed table, not an effective-policy audit. On load, an invalid agent's stored
argument list is dropped without resetting other settings or other agents' lists.

Conversation selectors are reserved for Foom's session actions: Claude resume,
continue, session-ID and fork-session flags; Codex `resume`/`fork` commands and
`--last`/`--fork`; Antigravity conversation/continue flags. This prevents launch
defaults from redirecting Resume or turning New conversation into a continuation.
Other agent arguments retain the existing validation and literal argv behavior.

Settings → Environment sets environment variables for **All sessions** (every
shell and agent) with per-agent lists in Settings → Agents, edited in place: a name, a value and a
**Secret** toggle per row, and a blank row to add one. A valid row saves when focus
leaves it and applies to new sessions; running sessions keep theirs. Agent rows
override All sessions for that agent. `PATH` only prepends directories. A proxy URL
with credentials is always secret. Secrets are stored with the system keychain, shown
masked with **Replace**, and never shown again. Main refuses reserved names (`FOOM_*`,
`CLAUDECODE`, `TERM`, `COLORTERM`, `TERM_PROGRAM`) and names that load code, with the
reason beside the row. With any proxy set, Foom appends `localhost,127.0.0.1,::1` to
`NO_PROXY` so its own endpoints stay direct. **Import from login shell** offers only
proxy and certificate variables and adds only the ones picked. A session's panel
lists the names Foom set, never values. The config folder cannot set environment
variables. See [the launch environment](../areas/agent-launch.md#launch-environment-215).

Agents and Forges show built-in plugins without a source mark. A config plugin
has a puzzle-piece icon beside its On/Off switch, named and titled
“Foom config · <file>”. The icon is informational: clicking it leaves the
switch unchanged. Rejected plugins retain a visible “Rejected · launch blocked”
line and reason. Agent capabilities appear as compact MCP, Resume and Inline chips
only when supported; blocked agents have none. The Capabilities row is omitted
when no chips apply. Their tooltips and accessible names
explain orchestration, reopening conversations and scrollback respectively.

Environment shows one hint above the rows: “Added to every shell and agent Foom
starts. Agent-specific variables are under Agents. Running sessions keep theirs.”
Agents opens the Agents tab.

Settings → Appearance groups mode and interface size together, with a separate
**Session panel color: Vivid / Subtle / Plain** group and a miniature live session
panel beside the control (below it in narrow layouts). The preview uses real panel
styles and reflects contrast overrides.
Vivid is the default. It scales header, mark, command-column, chip-fill and
glow decoration only. Status text and outlines retain color and words. High
Contrast and `prefers-contrast: more` force Plain and full-strength chip outlines.
Decoration uses highlight; Working continues to use accent.

Appearance contains only non-theme settings and shares the preflight rail's System/Light/Dark and interface-size controls.
Changing either view is reflected in the other without restarting.

Terminal font lists the bundled Hack Nerd Font Mono first, followed by installed
monospace families. The choice persists and applies immediately to every terminal
view, including config shells and the Settings preview. Open terminals refit their
columns and rows. Missing fonts fall back silently to Hack Nerd Font Mono, Geist
Mono and `monospace`.

Terminal font size applies to every terminal view: 10–32 pixels, 14 by default,
independent of interface size. The Themes section previews text size, all 16 ANSI colors, bold, dim and selection.
Terminal colors default to Follow interface, with Foom Light/Dark, Solarized Light/Dark
and Dracula built in. Changes apply live to visible and detached terminals.
Settings → Themes offers System, Eclipse Light, Eclipse Dark, High Contrast,
Deep Field, Moonlight, Graphite and Midnight Indigo, with a live preview of all six terminal statuses.
System follows the operating system's light/dark appearance. The other themes have
a fixed light or dark base. Changes apply immediately and persist. The preflight
and Appearance System/Light/Dark controls return to the corresponding Eclipse
appearance; changing interface size keeps the selected theme. Terminal color
schemes remain independent; Follow interface uses the light/dark base.

Themes holds both interface and terminal choices. Each picker lists shipped themes first,
then user themes below a divider, with file status and **Open themes folder**. Add interface JSON files to `~/.foom/config/themes/` and terminal
JSON files to `~/.foom/config/terminal-themes/`. New files and valid edits apply live,
without restarting. Rejected files appear below the picker with a filename, JSON
path and reason in failure styling. An invalid edit retains that theme's last good
colors for the current session. A missing or invalid saved choice at startup uses
Follow while retaining the choice; fixing its file restores the selection. Custom
names matching a built-in receive “(custom)”. See the [file formats and limits](../areas/themes.md#custom-theme-files-205).

Every interface theme keeps amber for Needs you, magenta for Failed, and violet for activity.
Needs you retains its halo, Failed its square light, and all states their labels.
High Contrast provides at least 7:1 text contrast and stronger borders.

Master **Volume** is first in Settings → Sound and stays in sync with the footer.
It defaults to 100%, persists with mute, and multiplies the individual working
and alert levels. Mute silences both without changing either level.

Settings → Sound offers a separate recording picker and preview for Working, Done,
Needs you and Refusal. Built-in and user files appear together, named from their
filenames. Working is off at 15% by default. One steady loop plays at the selected
volume while at least one agent is executing, including silent thinking and tool use.
More agents do not increase its volume. Completion of one agent leaves the loop
running for others. Plain shells produce no automatic sounds, including command completion and attention alerts.
Starting, idle, blocked and exited agents are silent. Unsupported agent versions stay
neutral until Foom receives supported lifecycle evidence. Alerts
cover Done, Needs you and Refusal and default to on at 50%. Each decoded recording
gets bounded loudness normalization so volume choices remain useful across files.

Needs you repeats every two minutes until the agent resumes or attention is dismissed.
Typing alone does not prove an agent has resumed. Shell replies still clear attention. Needs you is muted in
the focused tile of the focused window; Settings and preflight hide
that terminal and allow attention alerts again. Done plays once per completed agent
turn, including in the focused tile. Initial readiness is not a completion. Completion observed while muted is not
replayed. Attention reminders resume after two minutes away or after unmuting.
Verdicts settle for one second before sounding. Simultaneous alerts play once, with
Needs you taking precedence; verdict alerts are at least two seconds apart.
Full tile placement does not play Refusal. Visual status always stays on.

**Open sounds folder** opens `~/.foom/config/sounds/` in the file manager. Add files
to `working/`, `done/`, `needs-you/` or `refusal/`, then reopen Settings → Sound to
refresh. There is no import dialog. Supported files are OGG, Opus, WAV, FLAC and MP3;
only direct regular files with valid headers are accepted. Working files are at most
8 MB and 1–30 seconds; other files are at most 2 MB, with Done/Needs you up to 1.5
seconds and Refusal up to 0.3 seconds. Each folder lists at most 100 eligible files.
Hidden files, subfolders, names over 100 characters and links outside their kind
folder are rejected.

Choices persist as a source and filename, never a path. Missing or invalid choices
fall back to the built-in default with a reason beside the picker, without replacing
the saved choice; restoring the file and reopening Sound restores playback. Needs
you cannot select the same source/filename as Done or Refusal. Old soundscape settings
migrate while preserving switches and volumes. Previews use the selected volume even
when switched off; Working previews stop after five seconds. Sound credits are in
Settings → Sound and packaged third-party notices, ready for the future About screen
(#96). The 17 built-in CC0 recordings include drive chatter, teletype, typewriter,
projector, bells, percussion and short refusal sounds.

### Foom config

User themes may apply with brand warnings, shown by the CLI; file changes that make needs-you hard to distinguish wait for approval.

Settings → Foom config shows the config folder (`~/.foom/config`) with **Open
folder**. Agents configure Foom by editing that folder: `settings.json`, theme
files and terminal themes. The folder is plain files; Foom does not make it a git
repository, and users who want history can keep it in their own. Each valid change
applies live; an invalid file is rejected whole and the previous version stays in
effect. Changes that would make Foom less able to say something
needs you (turning alerts off, alert or master volume 0, master mute, hooks off, or turning an agent off)
wait in an amber banner, such as "An agent wants to turn off the needs-you sound",
with **Allow** and **Keep it on** in both the Foom config panel and Settings →
Foom config. Selecting the dock's Needs you opens that decision, even after the
config session closes. A decision on either surface clears it everywhere.
Keep it on restores the file. Config agents read `foom config status --json` after
settings edits and tell the human when a write is held; validation alone does not
mean the settings applied.

`agentArguments` in settings.json contains literal lists keyed by provider ID,
including the required `claude`, `codex` and `agy` entries. Every file-originated argument change waits for Allow, including removing
arguments. Allow opens the trusted dialog with each changed agent's before and
after lists, one argument per line, and names known bypass flags. Accepting also
records bypass acknowledgement. Settings edits write the same file directly and
retain their existing bypass disclosure. Running sessions keep their arguments;
new, resumed and restored launches use the approved defaults.

Valid agent manifests load without approval. Their installation, edits and removal
refresh every board launch menu and the application menu without visiting Settings.
MCP launch tool lists use the current provider registry.

Below the folder, the section shows only what needs the user now: a held change,
or each rejected file with its reason. When all is well it shows nothing more.
Changes made in Settings are written to the same file. See the
[architecture](../areas/config.md#foom-config-environment-84).

General includes **Check for updates** (on by default), **Update available** for
notice-only channels, and a fixed **Could not check for updates.** failure message.
A downloaded stable macOS update offers **Restart to update** and the number of
running agents. Restart follows normal quit confirmation and session saving.
See the [channel and privacy policy](../product.md#updates-603).
