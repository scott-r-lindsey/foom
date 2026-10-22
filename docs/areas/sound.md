# Sound

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/settings.md).

## Recorded sounds

`shared/sound.d.ts` defines four kinds and path-free `{source, file}` choices.
`shared/sounds.ts` validates exact keys, filename syntax, switches, finite volume
bounds and distinct Needs you choices. Only settings loaded from disk can migrate
the former `soundscape` property; IPC accepts the new format. Migration preserves
switches and volumes. The existing setup IPC and atomic store persist choices.

`main/sounds/library.ts` creates `~/.foom/config/sounds/{working,done,needs-you,refusal}`
and merges its catalogs with read-only `build/sounds/` inside the packaged resources.
The build copies the approved OGG/Opus recordings, manifest and notices; notices also
feed `build/THIRD_PARTY_NOTICES.txt`. Settings exposes sound credits until the About
screen (#96) consumes the shared notices. The manifest records original authors,
URLs, CC0 licenses, retrieval dates, source and derivative checksums, and edits.

`sound:list` and `sound:read` validate the main window's top-level sender and exact
argument counts. Read requests contain only kind/source/filename. Main accepts direct
regular files, rejects hidden/overlong/unsafe filenames and out-of-folder symlinks,
checks extension against header, and bounds each folder to 100 files. Working files
are capped at 8 MB; others at 2 MB. User reads use an inspected descriptor, bounded
allocation and directory/name rechecks. `sound:open-folder` calls `shell.openPath`
only on the fixed main-owned folder; `sound:notices` reads a fixed bundled file.
No arbitrary filesystem capability, URLs, Node APIs or CSP exceptions reach the renderer.

Opening Sound lists folders again and emits `sound:changed`, refreshing cached choices
so restored files take effect without a restart. The renderer decodes IPC bytes with
`decodeAudioData`, validates durations (Working 1–30 s, Done/Needs you ≤1.5 s, Refusal
≤0.3 s), and measures RMS and peak. Gain targets −25 dBFS RMS, capped at 4× and a
−6 dBFS peak; silence stays silent and nonfinite samples fail. Invalid selections
fall back to the default and report a reason, never rewriting saved choices.

The sound controller subscribes to board and setup sources. It reads main-owned
execution metadata, never output rates. One steady loop at the selected volume
plays while any agent is working; shells and exited sessions are excluded. Shell rows
are also excluded from verdict alerts, so command completion and shell prompts stay silent. An on-demand 100 ms clock runs only while alerts or attention reminders are
pending. It settles verdicts for
one second, spaces alerts by two seconds, gives attention priority and repeats
outstanding attention every two minutes. State changes, removal and disposal cancel
reminders; repeated verdict IDs do not restart them. Attention is muted in the focused tile while the document has focus, excluding
Settings, preflight and location views. Completion remains audible when focused and
is deduplicated by launch and turn; initial readiness and restored verdicts are silent. Muted
completion is consumed. Settings must load before sound; later settings events take
precedence over a pending initial load. No terminal text enters audio.

`renderer/sound/web-audio.ts` owns one loop, one verdict voice and an independent
Refusal voice. Full tile placement no longer calls Refusal. The retained Refusal preview obeys Alerts and its
volume without verdict settling or debounce. Context resume, gain ramps, asynchronous
decode cancellation and cleanup are owned here. Audio failure leaves terminals and
visual status operational. Settings previews stop on replacement/unmount and after
five seconds for Working (two seconds for other kinds). No synthesis remains.
