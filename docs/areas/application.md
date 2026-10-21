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
