# Product

Foom is a desktop workspace for running many coding agents at once, in git worktrees with one terminal per session. Its job is to route your attention. Terminals can stay hidden or share the workspace in tiles; Foom tells you which one needs you.


The target is about 10 concurrent agents. Bundled agents are Claude Code (`claude`), Codex (`codex`) and Antigravity (`agy`). Valid config-authored plugins add providers; other CLIs can run in a plain shell watched by the evaluator.

Start with the [file map](map.md) and read the rules for the area you are changing. Decided rules live in the linked area and behavior documents; protocol details live in the contract documents. Changes to established decisions require their own PR and matching docs.

## Terms

See [Terms](behavior/overview.md#terms).

## The light

See [The light](behavior/attention.md#the-light).

## Terminal sidebar

See [Terminal sidebar](behavior/sidebar.md#terminal-sidebar).

## Application menu and attention badge

See [Application menu and attention badge](behavior/menus.md#application-menu-and-attention-badge).

## Confirmations

See [Confirmations](behavior/confirmations.md#confirmations).

## Terminal tiles

See [Terminal tiles](behavior/tiles.md#terminal-tiles).

## The evaluator

See [The evaluator](behavior/attention.md#the-evaluator).

## Orchestration and privacy

See [Orchestration and privacy](behavior/orchestration.md#orchestration-and-privacy).

## First run

See [First run](behavior/setup.md#first-run).

## Settings

See [Settings](behavior/settings.md#settings).

## Windows and quitting

See [Windows and quitting](behavior/windows.md#windows-and-quitting).

## Mockups

See [Mockups](behavior/overview.md#mockups).

## Config agent probe terminals (#591)

See [Config agent probe terminals (#591)](behavior/probes.md#config-agent-probe-terminals-591).

<a id="delete-merged-worktrees"></a>
See [area rules](behavior/worktrees.md#delete-merged-worktrees).

<a id="new-worktree"></a>
See [area rules](behavior/worktrees.md#new-worktree).

<a id="child-board-placement-and-close-377"></a>
See [area rules](behavior/orchestration.md#child-board-placement-and-close-377).

<a id="foom-config"></a>
See [area rules](behavior/settings.md#foom-config).

<a id="shell-status"></a>
See [area rules](behavior/attention.md#shell-status).

## Error presentation

See [Error presentation](behavior/errors.md#error-presentation).

## Launch art and About

First-run launch draws the brand’s exponential flight path with a rocket past the
Eclipse black hole and stars flying toward the viewer. About Foom is an in-board
art dialog on every platform, replacing the native About panel. See
[launch behavior](behavior/setup.md) and [About behavior](behavior/menus.md).

## Updates (#603)

Settings → General has **Check for updates**, on by default and stored in the
profile. Packaged builds check at launch and every six hours. Turning it off stops
future checks and aborts a pending metadata GET. An already staged macOS update
can still install on quit; an updater-managed download already in progress may
finish. Development launches never check.

Stable macOS builds use Electron `autoUpdater` with update.electronjs.org for
stable GitHub Releases. Downloaded updates install on the next normal quit.
Foom never automatically restarts or stops agents for an update. **Restart to
update** shows the running-agent count and uses the ordinary quit confirmation,
session save and terminal shutdown; cancelling or failing quit leaves work running.
Session restoration follows the saved setting on the next launch.

Stable Linux builds show **Update available** using an anonymous GET of
`api.github.com/repos/scott-r-lindsey/foom/releases/latest`. CI-stamped nightly
builds on every platform check the rolling `nightly` GitHub prerelease and show
only a notice. Windows also uses notices only; its releases are currently
nightly-only. Nightly in-place installation belongs to #604.

Update checks are Foom's only app-owned outbound network feature. Metadata
requests go to update.electronjs.org and api.github.com and contain only the app
version and platform (including architecture for the macOS feed), never terminal
content, repository paths, agent identities or credentials. Those servers see the
client IP address and app version. Failures stay quiet apart from **Could not
check for updates.** in Settings. Tests use fake updater and HTTP services.

On stable macOS, the native updater also downloads the signed ZIP from the GitHub
release asset URL returned by update.electronjs.org, including GitHub release
asset hosts. The same switch controls metadata checks, notice API GETs and these
native downloads; no other hosts are added. GitHub's download servers also see
the client IP and request metadata. Native downloads already started cannot be
cancelled through Electron's updater API; opting out prevents new checks and
downloads, but an in-flight download may finish and a staged update may install
on normal quit.
