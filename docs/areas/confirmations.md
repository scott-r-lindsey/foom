# Confirmations

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/confirmations.md).

## Confirmations

`main/confirmations/arming.ts` owns the click-again capability. A validated workspace
command begins one generation and retains its action/target in main while its
confirmation callback waits. Main emits `confirmation:armed` with a random UUID,
the canonical target and a consequence label. `confirmation:confirm` must carry
that exact nonce and target, arrive at least 300 ms after arming and no more than
three seconds later, and come from the board's top frame. A monotonic clock checks
the deadline independently of the expiry timer. Acceptance consumes the nonce
before resuming the operation; forged, mismatched, early and replayed answers do
not approve anything. `confirmation:cancel`, expiry, replacement, navigation and
renderer loss revoke pending arming. Generation checks reject delayed preparation
after cancellation. Existing workspace locks, identity/status rechecks and launch
validation remain in force while an operation awaits confirmation.

Workspace callbacks pass a typed confirmation kind, with an exhaustive label map;
labels never depend on matching user-facing prose. Click-again only prevents
misclicks: the board receives its nonce, so a compromised board can confirm after
300 ms. It is not a trusted user-consent boundary. Data-discard and permission-widening
actions must use the trusted window. Saving bypass defaults (#164/#167) uses this
main-only `TrustedDialog` API, preserves the full disclosure text and focuses
Cancel by default; it never uses click-again.

The board receives arm/end events through its source's `ConfirmationClient`.
Menus and launch buttons keep only view state; pointer exit, focus movement and
unmount disarm main. A trusted-dialog notification closes a menu and restores its
anchor before the separate window takes focus. Main-originated end events reset
armed labels without closing a menu on expiry. The legacy launch and removal IPC
entry points use the same gate; a renderer-supplied force or shared-checkout flag
cannot answer a confirmation.

`main/confirmations/trusted-dialog.ts` deliberately preloads one hidden, frameless
child window for each board at creation. Each extra renderer process lives until
its parent board closes: this trades memory for immediate confirmation even when
the board has crashed or hung. Do not move its initialization into the renderer or
lazy-load it on quit. Its background throttling is disabled so a reused request
can render and report dimensions while the child is still hidden. With no macOS boards, quit opens a board and its trusted
child before asking for confirmation.
A separate in-memory session and `app://confirmation/confirmation.html` origin
isolate its renderer process from the board. The opaque frameless window contains only
its raised card, with a native shadow and platform rounding where supported (square
corners on Linux). The board draws a cosmetic translucent scrim in the top layer, covering any open
board form, from the boolean-only
`confirmation:scrim` notification. Hiding or failing to draw it grants nothing.
Native `modal` is false to avoid macOS sheet presentation; Linux explicitly uses
the native `dialog` window type for transient stacking. On Windows main disables
the parent. Linux leaves it enabled so clicks can recover an unavailable child;
a disabled parent swallows those clicks without a focus event. On macOS,
Electron's `setEnabled(false)` attaches a
translucent sheet above even a focused child (#353), so main instead temporarily
makes the board nonfocusable. On every platform main consumes board mouse and
keyboard events before renderer dispatch, including board shortcuts. A mouse-down
or key-down on the blocked board re-presents the child (show, bounds, raise and
focus), as does parent focus. Recovery never forwards the original input to the
dialog or board. Each dismissal restores the original native focusability or
enabled state and removes the input guards. The page uses a ResizeObserver to report
natural card dimensions in CSS pixels via `confirmation:size`. Main accepts only
finite positive sizes from the trusted main frame at the exact confirmation URL,
while a request is pending. It multiplies by the board zoom, clamps to the parent's
content area less a 24-DIP margin and the display work area, and centers the card on
the content bounds. The card's content scrolls when constrained. Main shows the
window only after its first valid measurement, re-establishes the parent link,
reapplies positioning after show, and raises it with `moveTop()` before focusing.
On macOS, a measured quit confirmation activates the app with
`app.focus({ steal: true })`, because native window focus alone cannot activate
Foom when another app is frontmost. Only confirmations a person started may
activate. Agent, CLI pairing, preview and workspace requests never bring Foom in
front of another app; when Foom is inactive they cancel as before. Activation
grants no approval; a child that still cannot acquire focus follows the same
cancellation checks.
A main-owned one-second guard cancels if the page never measures. A shown child
that cannot acquire native key focus gets one reorder attempt and a second
one-second check; failure cancels without approving, clears the scrim and releases
board input. Windows/Linux also require native visibility. On macOS, current key
focus takes precedence over occlusion reporting, which can disagree with the
visible child during reuse (#353). All platforms read back native bounds and
require the entire measured card within the parent's display work area, within
2 DIP of the requested position and size. Focus and visibility alone can describe
an off-screen mapped child and are insufficient. A successful check schedules
another in five seconds to detect silent losses. Resume, unlock, display removal
or metric changes, and parent show/restore re-present and check the dialog too.
Reentrant focus events cannot extend the final recovery deadline. Native
presentation exceptions decline immediately. Every positive answer, including
cleanup actions and removal subsets, must pass the same focus, visibility and
geometry checks at IPC receipt; recovery itself never grants approval.
Hiding, minimizing or destroying the child, or hiding/minimizing its board, also
cancels after checking current native visibility/minimization, so a late Cocoa
hide notification cannot dismiss a newly visible reused request. Timers and
listeners are removed on dismissal and disposal.
These focus checks are a recovery safety net; the Electron regression observes
composed desktop pixels, since macOS can report native focus through an overlay.
Theme and Interface scale updates reach the dialog while pending; parent move,
resize, maximize, unmaximize and restore events recenter it. Dismissal removes
listeners, clears the scrim, and restores input and focus. Positioning remains
subject to window-manager restrictions (for example native Wayland). Quit approval
does not need the board to render.
Main serializes requests, supplies the current
resolved theme and content, and gives each request a new ID. Content carries a glyph,
subject, labeled disclosure sections (with optional main-authored collapsed summary
lines and full tooltip/accessibility text), facts, argument chips and the pairing code with
its main-owned expiry deadline. The sandboxed preload requires the request ID, complete resolved theme, title
and accept label, and validates every optional nested disclosure, removal, cleanup,
reply, pairing and session field before buffering or publishing a request. A
malformed request clears the rendered request to null. This includes summary line
text and optional full titles. Both are capped at 8,192
UTF-16 code units and reject control characters, Unicode line/paragraph separators
and bidi controls U+202A–U+202E, U+2066–U+2069, U+200E and U+200F. Main refuses
unsafe plugin summaries before requesting confirmation, including raw executable
and fixed argument strings before command quoting. Plugin staging computes
12-character hash displays, full hashes and UTF-8 sizes in main; full hashes also
remain selectable in the expanded file byte boxes. Plugin executable summaries
use the executable basename and fixed argv, with middle truncation computed in
main and full commands, including the absolute executable path, retained in titles
and accessible names. These presentation summaries never
change the accepted action or its revalidation.
The shared anatomy uses 500 CSS pixels for prose and 540 for lists and disclosures;
main still applies zoom and the parent/work-area clamps. List names wrap in their own
grid column; state and retention labels never wrap. Pairing counts down to the actual
request deadline, including time spent waiting behind another dialog. Cleanup checking
counts come from the latest inventory; fetch ages use the successful main-owned fetch
timestamp, never a new timer started by opening the dialog. Its sandboxed preload
exposes only request rendering, sizing and answering; it buffers the request until the page
subscribes. `confirmation:answer` validates the exact window, top frame, URL,
request ID and boolean, or a nonempty, unique subset of displayed operation IDs
for a batch removal. Main groups pending removals by orchestrator generation and
rotates the request ID on list changes. A single removal keeps the ordinary
boolean confirmation. The board cannot submit either answer. Board frames, stale IDs
and malformed answers are ignored.
Closing, renderer failure and disposal cancel. A failed window is recreated for
the next request. This main-only content API also serves merged-worktree cleanup and can later serve #119.

The trusted session denies permissions and navigation, blocks new windows and
webviews, and serves only its page, script, styles and bundled fonts. Context
isolation and sandboxing stay enabled; Node integration stays disabled. Its CSP
matches the board's restrictions. React renders titles, filenames and session
metadata as text. The page traps focus within Cancel, the confirming button, disclosure
summaries, expanded byte boxes and (when scrolling) the content region,
handles Escape, focuses Cancel for every request, and respects reduced motion.
Quit inventories live terminals in main, including shells outside the workspace
snapshot; it does not query the board. Renderer loss immediately releases a pending terminal view flush; a crashed board
is not asked to flush again until it loads. The existing deadline still allows
shutdown when a live board is unresponsive.
