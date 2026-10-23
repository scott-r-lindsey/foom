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
future checks and aborts pending metadata and ZIP requests. A request already sent
may have reached the server, and received bytes cannot be recalled. No native
check starts after opt-out; a native local copy/verification already started may
finish and stage an update (or fail). Such a staged update, including one staged
before opt-out, can still install on quit.
Development launches never check.

Stable macOS builds use Electron `autoUpdater` with update.electronjs.org for
stable GitHub Releases. Downloaded updates install on the next normal quit.
Foom never automatically restarts or stops agents for an update. **Restart to
update** shows the running-agent count and uses the ordinary quit confirmation,
session save and terminal shutdown; cancelling or failing quit leaves work running.
Session restoration follows the saved setting on the next launch. If native
restart errors or has not exited within five seconds after shutdown, Foom calls
`app.quit`, then `app.exit(0)` one second later if still alive.

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

On stable macOS, Foom fetches metadata itself and accepts only an HTTPS ZIP URL
under `github.com/scott-r-lindsey/foom/releases/download/vX.Y.Z/`, with the matching
Foom architecture and version in the filename. The URL's version must be strictly
newer than the running stable version; release titles are not version evidence.
Foom downloads that signed ZIP itself, following at most three redirects, only
to `release-assets.githubusercontent.com` paths scoped to Foom's repository ID.
It then supplies Electron `autoUpdater` with a private local JSON feed and ZIP,
using `file:` URLs and `serverType: json`. Remote delta URLs and other feed fields
are discarded. Squirrel performs signature verification and installation without
outbound requests. Packaged macOS Info.plist also enables
`ElectronSquirrelPreventDowngrades` to reject older bundle versions.

The same switch controls all three request kinds: macOS metadata at
update.electronjs.org, the macOS ZIP from the two GitHub download hosts above,
and GitHub Releases API notices at api.github.com. GitHub's download servers see
the client IP and request metadata (including the offered version in the URL).
No other hosts are added. Redirect/error bodies are destroyed without being
read. The chain shares one cancellation signal, size budget and total deadline;
all requests close before preparation returns, including after success or opt-out.
Foom bounds and can abort its ZIP transfer; only local
native work already handed off is outside that cancellation boundary.
