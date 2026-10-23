# Application

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/windows.md).

## Application profiles

Before readiness or any profile store opens, unpackaged launches without
`--user-data-dir` select `Foom Dev` beneath Electron's platform `appData` directory.
This profile persists between launches. Packaged builds retain Electron's default
profile; an explicit `--user-data-dir` always wins, including tests and `start:fresh`.
There is no automatic migration or copying between profiles.

Main acquires Electron's single-instance lock after selecting the profile. A losing
launch exits before opening stores, sessions, IPC or shutdown writers. A second
launch restores, shows and focuses the existing window; distinct profiles can run
side by side. Unpackaged windows use the title **Foom Dev** and a neutral **Dev**
sidebar marker, including explicit test/fresh profiles. Main passes only a boolean
identity through the sandboxed preload; profile paths remain in main.

At startup, main removes inherited `FOOM_*` environment variables and `CLAUDECODE`
(the Claude nesting guard) before spawning child processes. Foom's per-launch
hook URL, token and session therefore cannot leak from the parent terminal into
the child app's sessions. Bash lifecycle integration uses an invocation-private
startup file and non-exported shell callbacks, not environment credentials.
Per-launch agent settings remain scoped to command arguments; user configuration
and unrelated environment variables are unchanged.

## Windows installer callbacks

Packaged Windows launches handle Squirrel install/update/uninstall/obsolete
callbacks before profile selection, locks or stores. Install/update creates the
Foom shortcut through the adjacent fixed `Update.exe`; uninstall removes it.
Each callback quits after the helper finishes (including failures). Normal
launches continue through the existing profile and single-instance lifecycle.

## Updates (#603)

Main owns update checks, timers and fixed status facts in `updates.ts`; the HTTP
adapter uses anonymous, bounded HTTPS metadata GETs. Settings stores the opt-out
in the profile. Only packaged builds check, once at startup and every six hours.
The [approved channel policy](../product.md#updates-603) distinguishes stable
macOS installation from notice-only Linux, Windows and all nightly builds.

Squirrel.Mac applies downloaded updates on ordinary exit. Receipt of an update
never quits, relaunches or kills a PTY. Explicit restart enters `requestQuit` and
can call the native `quitAndInstall` only after confirmation, window/session save,
PTY shutdown and service disposal succeed. Cancelled/failed quit never installs
through that explicit path. No Windows native updater is configured.

Foom fetches macOS metadata before invoking the updater, checks the version from
its repository-bound ZIP path, and downloads the ZIP through the constrained
adapter in `update-package.ts`. Only the exact GitHub repository download path
and repository-ID-scoped release CDN redirects are accepted. Non-final responses
(including redirects and errors) are destroyed immediately without consuming
their bodies. Every hop shares one abort signal, byte budget and total deadline;
completion and failure abort that scope too. Preparation waits for all tracked
requests/responses to close and removes its timeout and abort listeners before
returning. The private local
feed contains only the validated version and local ZIP URL; no remote fields or
delta URLs pass to native code. The enabled flag and generation are rechecked
after each awaited operation and immediately before the native check. Opt-out
aborts Foom's HTTP requests, removes temporary staging, and prevents new native
work. Native local work already started may finish and stage an update that
installs on normal quit, or fail. Finished staging is
removed on native completion, error or disposal. Crash-interrupted temporary
files may remain in the profile; they are never reused as feeds.

This uses the pinned Electron 44.9.3 behavior: its
[macOS adapter](https://github.com/electron/electron/blob/v44.9.3/shell/browser/auto_updater_mac.mm)
passes `serverType: json` and feed NSURL to Squirrel. Its
[DEPS](https://github.com/electron/electron/blob/v44.9.3/DEPS) pins Squirrel.Mac
`fffea30e4a339a7f7d69a3391314b72548d209bd`.
[SQRLUpdater](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/Squirrel/SQRLUpdater.m)
loads the JSON file's `currentRelease`/`releases[].updateTo`, and
[SQRLUpdate](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/Squirrel/SQRLUpdate.m)
accepts file URLs. Its
[SQRLDownloader](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/Squirrel/SQRLDownloader.m)
uses NSURLSession, whose [supported protocols include file](https://developer.apple.com/documentation/foundation/urlsession).
A local feed with a remote ZIP would still follow uncontrolled redirects; both
URLs must be local. The native CI companion runs an offline macOS Foundation
fixture through NSURLConnection and NSURLSessionDownloadTask with local files,
so a platform that cannot consume either file URL fails validation. It uses no
real updater or HTTP requests. Squirrel's saved resume data is keyed to the exact requested
URL, so prior remote downloads cannot resume for a fresh private local ZIP URL.

Forge extends the packaged macOS Info.plist with
`ElectronSquirrelPreventDowngrades: true`; Squirrel verifies signatures and
rejects older bundle versions as a second defense. After shutdown, explicit
`quitAndInstall` is guarded by a five-second watchdog. A synchronous throw,
native error (including after service disposal), or watchdog expiry calls
`app.quit`; a further one-second watchdog calls `app.exit(0)` if still alive.
These fallbacks cannot re-enter session saves or PTY shutdown and never run
before the successful normal quit barrier.
