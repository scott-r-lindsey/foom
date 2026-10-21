# Commands

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/menus.md).

## Board shortcut definitions

`shared/board-commands.ts` owns static board action IDs, shortcut definitions and runtime validation; the `BoardCommand` declaration derives its static union from that data. `main/window/commands.ts` owns the application command registry: IDs, native and wordmark
labels, platform bindings, enabled/checked state, agent badges, shortcut-sheet
rows, native roles and actions. `app-menu.ts` projects this one registry two
ways: every implemented command to the macOS menu bar, and a curated, fixed
layout to the wordmark menu on every platform. The wordmark projection is data
only (`AppMenuEntry`): commands, separators, the Settings submenu (the agent
routes come from the live provider registry, followed by Via Settings UI), and a
`size` row carrying Bigger/Smaller and main's current interface scale. Action log
is an enabled board command in both the wordmark and macOS menus; it has no direct
shortcut binding.
Main owns one `before-input-event` dispatcher, shared by the board and every preview
(including its synchronous focus-handoff and trusted-dialog input guards); native accelerators are
display-only (`registerAccelerator: false`). Windows/Linux have no native
application menu. The existing two-second Ctrl+Shift+Space tile leader resolves
from the registry; blur, timeout and unmatched input cancel it. Alt alone and F10
open the wordmark menu. Plain Ctrl letters and numbers reach the terminal; the
Keyboard shortcuts binding is Ctrl+Shift+/ (Command+/ on macOS).

The `app-menu:list`, `app-menu:shortcuts`, `app-menu:execute` and `app-menu:view`
invoke handlers accept only the owning window's trusted top-level frame. Execute
accepts an existing, enabled command ID and awaits its action, so a Size step
resolves after main saves the new scale; it never accepts code, URLs, paths or
arbitrary terminal IDs, and it refuses submenu and row IDs and every disabled
command. Shortcuts returns the sheet columns generated from the registry for the
current platform; `app-menu:shortcuts` from main to renderer (no payload) asks
the board to show it. View accepts bounded tile counts and booleans solely for
presentation availability and the maximize checkmark. The board source exposes
this small typed capability. Add repository reaches the board as the
`add-repository` board command and uses the sidebar's picker path.
The live provider `via-<agent>` commands use the same registry for native and wordmark
menus. Main derives their availability from discovery and saved agent switches;
the board reports config-launch availability separately from tile availability,
so Settings can stay open while choosing an agent. Preflight disables these routes. Availability refreshes on menu reads, execution, window
focus and settings updates. The preload validates bounded syntactic provider IDs; main checks the live provider registry before launch.
The board dispatches the existing `config-launch` command,
awaits the source's refreshed inventory, and opens the newly created config session
through normal session selection. Menu and sidebar launches use the same launch policy without notifier confirmation.

The renderer reuses RowMenu's keyboard navigation, portal and dismissal behavior.
RowMenu renders a submenu as a nested portal anchored to its item: the top-level
menu owns outside-press, scroll and resize dismissal for both, and each level
handles its own keys. A stepper row is one navigation stop whose buttons run
without dismissing; the app menu repositions rather than closing when an
interface size step resizes the window. Menu selection and native shortcuts
dispatch identical main-owned actions. Application-menu actions dismiss before
dispatch, independently of row-action confirmation cancellation. They restore
the previous focus and selection first, so native editing targets the original
input; navigation commands then own their destination focus. Escape continues to
return focus to the wordmark, including when a press on a disabled item left
focus on the body. The shortcut sheet is a modal `<dialog>` that closes itself
before restoring the focus it captured.
Development commands are omitted when packaged; packaged webContents also set
`devTools: false`. Quit goes through the app-level confirmed shutdown; Close Window hides its views unless it is the last Windows/Linux window.

`attention-badge.ts` derives attention counts from main's workspace snapshot on
inventory and verdict changes. Windows overlays are generated BGRA bitmaps;
macOS gets a Dock badge and a menu whose waiting-session callbacks carry main-owned
terminal IDs. The validated preload notification selects an existing board row.
Linux uses `app.setBadgeCount`, which is a no-op on unsupported desktops. Renderer
activity rates never determine badge counts.

Terminal view operations recheck current inventory when queued work executes.
The validated `terminal:availability` notification carries terminal IDs in a batch.
It revokes each ID locally on removal, before asynchronous inventory refresh, and
suspends view work before shutdown. Preload acknowledges a subsequent ID-scoped
flush after the current renderer turn; main validates sender, IDs and token and
waits for that acknowledgement before revocation. A three-second fallback permits
cleanup when the renderer is crashed or unresponsive. A failed shutdown restores availability and
the previously selected view unless the user changed selection. Removing a terminal releases
its controller locally; known lifecycle actions hide
its view before revoking the capability. A hidden controller never detaches a
later owner's attachment. View queue failures become status text and cleanup
still disposes controllers. Main continues to reject unknown and foreign IDs.

About dispatches the validated `about` board action, including from the macOS
menu; windowless macOS About opens a board first. The app-menu bridge also
provides `version()` via trusted `app-menu:version`, returning only bounded app
and Electron version strings. The existing command execution route owns fixed
Licenses, notices and source actions; it accepts no renderer file path or URL.
