# Previews

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/tiles.md).

## Previews

`previews/host.ts` owns view lifetime, focus handoff, bounds, snapshots and transfers. `previews/partition.ts` creates the isolated session and view, serves preview responses and checks request/navigation policy; `previews/hosted-preview.d.ts` declares the per-view state.

Main owns a `PreviewHost` per board window and registers the standard, secure
`foom-preview` scheme before readiness. Each view has an in-memory `preview-<id>`
partition and an origin named by a random 128-bit ID. Its session handler captures
`canonicalRoot` once at preview open and passes only that root and its exact
`foom-preview://<id>` origin to `readPreview`. URL normalization
precedes per-segment decoding; credentials, ports and foreign origins are refused.
The pure policy rejects empty/dot segments, encoded separators, NUL, controls,
hidden names and Windows aliases (colons, trailing dots/spaces, device names and
reserved characters) on every OS. Queries and fragments do not name files.

Resolution uses `realpath.native`, a byte-exact root/separator comparison with no
case folding, and another segment check after symlinks. Directories resolve their
`index.html` through the same containment checks. Main stats before opening,
refuses non-files, opens the resolved path with `O_NOFOLLOW | O_NONBLOCK`, and
verifies descriptor type and `dev`/`ino`. Windows exposes neither flag through
Node; zero substitutes explicitly there, with the descriptor checks retained.
Only the verified descriptor supplies bytes; reads are bounded by its checked
size (16 MiB, or 2 MiB for Markdown) and handles close even on read failure.
`openInside` transfers handle ownership to its caller, which must close it.

Malformed paths return 400, escapes/hidden targets/non-files 403, missing or
unreadable files 404, and oversized files 413. Types use a fixed extension map,
with unknown extensions served as `application/octet-stream`. Success and refusal
headers include `nosniff`, `no-store` and `no-referrer`; HTML uses the default CSP
in `docs/previews.md` §4, and Markdown has no inline scripts, frames or workers.
Network permission defaults off and is never persisted. Each session filters requests to its own
origin plus `data:` and `blob:`; a confirmed per-preview permission also permits
`https:` and `wss:` and adds secure sources to its response CSP. Plain `http:` and
`ws:` remain blocked. The board's validated `preview:network` command requests a
trusted disclosure before enabling; disabling closes connections and reloads with
the restricted CSP. Each session denies permission checks, permission requests and
device requests, and prevents downloads. The view has no preload, uses sandboxing
and context isolation, disables Node integration (including workers and child
frames), dialogs, drag navigation and webviews, and disables devtools in packaged
builds. Window opens and redirects are prevented. Eligible external URLs (`https:`,
`http:` and `mailto:`) go through the trusted confirmation window with the full
URL before main calls `shell.openExternal`. Navigation requests use this same
path even without a user gesture. A per-preview pending guard drops overlapping
requests; close aborts pending review and revokes any later answer. Only same-origin `.md` or
`.markdown` page navigation is allowed; HTML navigation is blocked.

Markdown responses embed the source as inert JSON with every `<` escaped, then run
one synchronous browser bundle inside the preview origin. markdown-it 15 disables
raw HTML and accepts only relative, HTTP(S) and mailto links; highlight.js 11 uses
its common subset. A small core rule generates disabled task checkboxes. Mermaid
remains escaped code. Relative Markdown links navigate within the same tile;
external links have a visible arrow and go through the same confirmation.
The exact `/__foom__/markdown.js` and `/__foom__/markdown.css` assets are served only
by preview sessions; the reserved `__foom__` segment cannot name worktree files or
symlink targets. The isolated stylesheet uses Eclipse tokens and follows
`prefers-color-scheme` from `nativeTheme`; custom interface themes are not conveyed.
Bundled dependency licenses are included in `THIRD_PARTY_NOTICES.txt`.
Every non-hidden file in the captured worktree is readable by a preview page.

As in the spike, a parent directory swap between realpath/stat and open is not
fully prevented: `O_NOFOLLOW` protects only the final component. Descriptor
identity checks catch a different opened file, but are not an atomic directory
traversal guarantee. This residual race must not be treated as a general-purpose
filesystem sandbox. Junction escape tests run on Windows; all pure filename and
URL rules run on every OS.

The main-owned registry stores `{ id, worktree, relativePath, network: false }`
per stable window ID in profile JSON, with bounded validation and serialized
atomic writes. Paths never enter layout localStorage. Opens revalidate membership
and canonical checkout identity against registered worktrees, then validate and
read the contained document. `preview:pick`, `preview:close` and `preview:bounds`
use `WindowIpcRouter` to validate the owning board, exact app URL and top frame,
and validate argument counts, worktree IDs and finite bounded rectangles.
The picker command carries only the inventory worktree path that identifies the checkout.
Main dismisses the command panel before the native picker can change focus, so
blur cancellation cannot leave a panel covering the loaded preview. It shows the
picker rooted there and derives the relative document path;
the renderer never chooses or sends a document path.
IDs grant access only within their owning window. Sidebar inventory reports those
IDs and display facts. The board places human previews with `placeContent`, preserving
focus, and measures each preview body to report bounds through the source interface.
`preview:popout` validates the owning board and preview ID, opens a board window,
then destroys the source contents and releases its watch, protocol and partition
handlers before transferring the registry record with the same ID and attribution.
The record remains discoverable throughout cleanup; concurrent close follows the
transfer. Network resets to Off. The preload retains at most 256 unexpired placement requests until its board
subscribes, so a slow mount cannot lose the move. The target creates a fresh view on placement,
never reparenting a native view or hosting the preview in two windows at once.
Restored registry entries stay detached and allocate no view until bounds arrive.
Confirmed Foom worktree removal closes that checkout’s previews in all windows before
Git runs, releasing live-reload directory handles. New preview opens are refused
until removal finishes, including opens awaiting registry persistence. External
removal closes previews when workspace inventory refreshes; on Windows, close
preview tiles first because directory watches can block external deletion.

The test-only `tests/electron/preview-move-measurement.js` benchmark records board
load, validation, release, registry writes, placement, preview load and snapshot
timings, Git spawn counts for moves/launches/sidebar refresh/worktree creation,
and main-loop delay in JUnit diagnostics. Run it after a build with
`xvfb-run -a node --require ./tests/helpers/setup.js --test --test-reporter=junit tests/electron/preview-move-measurement.js`.
It includes 0, 5 and 15 streaming fixture agents plus a realistic gallery case:
20 worktrees in one repository, a second registered repository, Forge display/polling through
fixture `gh`, five streaming agents with three visible terminal tiles, and sixteen
roughly 2 MiB PNGs. The gallery repeats each move from the populated source window.
It records menu-click/window/renderer timestamps, sidebar requests/responses,
placement (including its five-second deadline), bounds, view load, capture/PNG
encoding/IPC size and the renderer paint acknowledgement. Set
`FOOM_PREVIEW_MOVE_SCENARIO=realistic` to run just that case and optionally
`FOOM_PREVIEW_MOVE_REPORT=/tmp/preview-move.jsonl` to retain diagnostics immediately.
A separately compiled original `worktree-operations` module supplied through
`FOOM_PREVIEW_MOVE_IDENTITY_MODULE` selects the baseline helper and original
unshared sidebar path; realistic fixtures are prepared before the swap, and one
move per app keeps the existing watchdog intact. Restore happens before teardown.
It uses isolated profiles and the standard agent guard/process audit. It adds no production tracing and records no terminal
content. Move validation still runs before and after source cleanup; identity
bookkeeping uses the fresh in-process metadata reads described in
[worktrees](worktrees.md).

An unfocused preview never acquires keyboard focus on open, reload or navigation. Main loads
it detached and attaches only after `did-finish-load`, when its board rectangle is
visible. Main-frame reloads and allowed navigation replace the old native
contents with a fresh detached view in the same partition, preserving ID and bounds.
If the old preview held user focus, the replacement receives focus after loading
and attachment, unless the user clicked elsewhere while it loaded. Before detaching
or closing a user-focused preview, main blocks the board's native keyboard events
(including shortcuts) until that handoff completes. Native fallback focus does not
cancel the handoff; a native mouse-down on the board or another preview does,
allowing ordinary input immediately. Hiding or closing the pending preview also
unblocks board input. Escape, window blur, or a 1.5-second deadline cancels a
pending handoff and discards its focus intent, including if attachment failed to
acquire native focus. Cancellation first blurs an active terminal in the trusted
board DOM; main keeps blocking keys until that operation completes. The board's
shortcuts and keyboard navigation then work, while ordinary typing cannot reach a
PTY until the user selects a target. A late load cannot restore cancelled focus.
These listeners and the deadline belong to the host and are disposed with it.
Recreation is bounded to once per 250 ms per preview; the old contents closes immediately
and only one replacement can be pending. Closing cancels pending recreation.
A previously clicked native contents can reacquire keyboard focus during reload on
macOS even when detached; replacing it prevents that remembered focus grant.
`did-start-loading` also detaches any loading view. Refused navigation leaves the
loaded view in place. A native mouse-down grants focus; navigation carries that intent to the replacement.
Blur or detachment otherwise revokes the native click grant. Unsolicited
focus on an attached view returns to the last human-focused contents. This guard
supplements detached loading; returning focus after load alone loses keystrokes.
Main scales CSS rectangles by board zoom, applies that zoom to each view, clamps
them to window content bounds, and refreshes on resize and interface-scale changes.
Closing destroys contents, unregisters its protocol/request handler, clears storage
and cache, and removes the registry entry. Quit preserves validated registry
metadata while releasing views and partitions. The session protocol handler records served and missing contained files. Each
preview watches their parent directory entries with non-recursive `fs.watch`,
filtered by name, capped at 64 directories. Requested symlink names and parent
symlinks/junctions are watched as well as resolved targets. Missing nested parents
use their nearest existing contained ancestor until a reload can subscribe closer.
A 120 ms trailing debounce with a one-second maximum wait triggers the existing
detached replacement path. Main captures finite, bounded `[scrollX, scrollY]` in
an isolated world and restores it after `did-finish-load`, before attachment.
Missing files show "File not found. Waiting for it to appear." and recover on
recreation. Closing or disposing the host cancels timers and closes watchers.

Every uncovered preview forwards native `before-input-event` to its owning board's
shortcut dispatcher and input guards, without moving focus. Geometry changes
(maximize, restore, hide and gutter resizing) do not cover previews: the live view
stays attached and follows reported tile bounds. Board panels (including portals),
trusted scrims, modal sheets, settings and tile drags still require a cover because
native views draw above the board DOM.

Main keeps a snapshot for each visible preview, refreshed after load (including
live reload), resize settle and native scroll/input idle. Refresh uses a 120 ms
trailing activity debounce, never a periodic timer. `capturePage` uses `stayHidden`
so a load completed under a cover can also be captured. Main sends PNG pixels, CSS
bounds and a monotonically increasing version through `preview:snapshots`, even
when uncovered. The renderer keeps decoded inert canvases beneath the live views
and acknowledges their version through validated, ID-scoped `preview:painted` after
two animation frames cross a paint. The board CSP and asset allowlist are unchanged.
Canvases follow their tile's bounds and opacity; stale decodes and acknowledgements
cannot hide a replacement view.

A cover with ready pixels hides the native child immediately with `setVisible(false)`;
it does not remove/re-add that child, avoiding the X11/Compiz reattachment problem.
Without ready pixels, the live child remains visible until paint acknowledgement,
with a 250 ms deadline from the cover request. During this exact fallback window,
main prevents native mouse and keyboard delivery to the preview. A click over the
still-visible child is consumed rather than reaching the board underneath; no page
control can activate. At the deadline main hides the child even if capture/decode
failed, prioritizing usable board controls. This exceptional failure can leave the
preview without pixels. Normal covers use the already-painted cache and have no
fallback input window. Uncover shows loaded visible children without granting focus
and retains the cache. Overlapping overlay reasons keep the cover active until all
finish; tile drag coverage begins before a drop target exists. Closing cancels
capture/deadline timers; late results cannot resurrect released views. Renderer
subscriptions, observers and animation work are disposed on unmount. Composition
ignores terminal/xterm repaint mutations and detached nodes; remaining board
mutations and snapshot positioning share one animation-frame update with tile
animation following. Mutation callbacks never scan layout.
