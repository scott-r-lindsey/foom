# Ipc

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners.

## IPC contract

Every channel checks the sender (a registered app window, its main frame, `app://bundle/index.html`) and validates every payload at runtime. Every terminal-scoped message carries a terminal ID. Creation returns the new ID; it accepts only dimensions, with shell and working directory selected in main. Worktree launch remains a main-only capability.

| Channel | Direction | Payload |
|---|---|---|
| `app-menu:legal` | renderer → main (invoke) / main → renderer | fixed `licenses` or `notices` ID → bundled text (1–1,048,576 UTF-16 code units); trusted board frame, preload validates IDs and text |
| `app-menu:version` | renderer → main (invoke) | no payload → `{ app, electron }`; trusted board frame, preload validates bounded version strings |
| `board:command` | main → renderer | registry board actions (including Tidy tiles and new worktree); preload rejects unknown commands, covered boards ignore them |
| `terminal:create` | renderer → main (invoke) | `cols`, `rows` → `{ id, title }` |
| `terminal:attach` / `terminal:detach` | renderer → main | `id` → snapshot via `terminal:data` on attach |
| `terminal:kill` | renderer → main (invoke) | `id` |
| `terminal:input` | renderer → main | `id`, `data` (≤ 64 KB; chunked on code-point boundaries) |
| `terminal:copy-selection` | renderer → main (invoke) | owned attached `id`, nonempty text ≤65,536 UTF-16 units; writes clipboard only while Copy on select is enabled; no read capability |
| `terminal:paste` | renderer → main (invoke) | owned attached live `id` → one validated `text` insertion or fixed `unsupported` / `empty` / `failed` / `cancelled` result; main captures clipboard on the gesture, binds work to the attachment generation and serializes a bounded FIFO; image bytes never reach renderer |
| `terminal:resize` | renderer → main | `id`, `cols`, `rows` |
| `terminal:ack` | renderer → main | `id`, attachment token, `count` (attached terminals only) |
| `terminal:data` | main → renderer | `id`, attachment token, `data` (attached terminals only) |
| `terminal:exit` | main → renderer | `id`, exit code (final screen retained until killed) |
| `terminal:tail` | renderer → main (invoke) | `id`, line count (1–10000) → plain text lines from the headless screen |
| `terminal:activity` | main → renderer | batched `[{ id, rate }]`, about 10 per second at most |
| `terminal:state` | main → renderer | `{ id, verdictId, state, reason, signal, confidence, timestamp }`; `verdictId` is null for user actions and unstored verdicts |
| `terminal:feedback` | renderer → main (invoke) | `id`, `verdictId` (null only for the current unstored verdict), `replied` / `dismissed` / `ignored` |
| `workspace:sidebar` | renderer → main (invoke) | → repositories with complete worktree inventories and the main-selected shell name |
| `workspace:sidebar-command` | renderer → main (invoke) | validated discriminated command: launch by registered repository/worktree and agent ID, stop/close/restart/take-over/make-orchestrator/revoke-orchestrator by owned terminal ID, remove linked worktree by validated path, or forget repository; main owns confirmations. Home-shell launch returns `{ terminalId }` for that request (preload validates and projects the ID); other commands expose no reply data |
| `workspace:snapshot` | renderer → main (invoke) | → `{ repositories, terminals }`, each launched terminal with its agent, repository, worktree, branch, and latest state |
| `workspace:add-repository` | renderer → main (invoke) | none; main shows the directory picker → repository or null |
| `workspace:changed` | main → renderer | invalidates the workspace snapshot after launch or removal; no payload |
| `workspace:worktrees` | renderer → main (invoke) | added repository path → worktrees |
| `workspace:branches` | renderer → main (invoke) | repository path → `{ head, local: [{ name, worktree }], remote, remoteBranches }` from refs already present; never fetches |
| `workspace:create-worktree` | renderer → main (invoke) | repository path, branch, optional `root` / `adjacent` (default: configured) → worktree plus `outcome`: `new`, `existing`, `origin` or `open`; launches nothing |
| `workspace:start` | renderer → main (invoke) | `{ repository, branch, run }` → terminal ID or null on cancellation; the board no longer uses it |
| `confirmation:scrim` | main → requesting board | boolean visibility only; cosmetic dimming, no dialog content or approval capability |
| `confirmation:render` | main → trusted renderer | validated request ID, content, theme and required boolean `presented`; confirming controls stay disabled until main completes its native presentation attempt; this flag grants no consent |
| `confirmation:size` | trusted renderer → main | finite positive `{ width, height }` in CSS pixels; exact trusted main frame, URL and pending request required; zoomed and clamped to parent content and display work area |
| `confirmation:answer` | trusted renderer → main | request ID and boolean for ordinary/single-removal and cleanup answers, or a nonempty unique subset of displayed operation IDs for grouped removals; exact trusted window, main frame, URL and pending ID plus reachability checks required; see [confirmation validation](confirmations.md#confirmations) |
| `workspace:remove` | renderer → main (invoke) | terminal ID → boolean; main owns confirmation and dirty-file inspection |
| `agents:scan` | renderer → main (invoke) | `refresh` → `{ warning, agents }` (no PATH) |
| `agents:launch` | renderer → main (invoke) | `{ agent, repository, worktree, cols, rows }` → `{ id, attention }` or null on cancellation |
| `setup:readiness` | renderer → main (invoke) | no arguments → fixed Git/forge readiness and platform enums plus selected repository DNS hostnames; no CLI output or paths |
| `setup:hosts` | renderer → main (invoke) | one closed host action; main owns registration, approved folders, origin and destination selection; fixed typed host/repository states only; see [Hosts](hosts.md) |
| `setup:state` | renderer → main (invoke) | → `{ settings, themes?, worktreeRoot }` |
| `setup:save` | renderer → main (invoke) | settings patch (known fields only) → state |
| `setup:changed` | main → renderer | setup state after a successful settings save or zoom shortcut |
| `environment:state` | renderer → main (invoke) | → `{ lists, windows, secrets }`; saved secrets have a null value |
| `environment:save` | renderer → main (invoke) | exactly `{ scope, previous, name, value, secret }`; a null value keeps a saved secret → state |
| `environment:remove` | renderer → main (invoke) | scope, name → state |
| `environment:read-shell` | renderer → main (invoke) | → importable candidates with masked credentials; values stay in main |
| `environment:import` | renderer → main (invoke) | names from the last read → state |

The renderer names repositories and worktrees only by paths main returned, and agents by ID. Main copies the known launch fields, checks the repository is registered and the checkout is authorized for that launch, and resolves the executable itself. A launched terminal belongs to the app; only its view is window-scoped.

## Preload response validation (#780)

The sandboxed bridges receive IPC values as `unknown` and validate required and
optional nested fields before exposing typed data. This includes workspace and
sidebar inventories, agent reports, settings/themes, config status, environment
rows, scans, menus, fonts and sound replies. Numeric fields must be finite;
counts and revisions must be nonnegative safe integers, and enum values must be
known. Malformed replies reject; malformed events never reach typed callbacks.
The existing window/audio read fallbacks remain empty/disabled valid state.
Invoke replies are recursively rebuilt from validated fields, including nested
arrays, unions and explicitly declared dictionaries; undeclared object properties
are not exposed. Byte replies are copied. Void capabilities discard internal
main-process return values.

`preview:place` validates its UUID request, 128-bit hex preview ID and positive
safe-integer expiry before buffering or dispatch. Expired requests are discarded;
human moves retain main's existing maximum-safe-integer expiry. The existing
256-request queue bound and main-side placement validation remain in force.

Validators stay inline in each preload. No runtime loader dependency or
main-side sender/payload validation changes.

## Error codes

Capability rejections and their fixed renderer messages follow the [coded error contract](errors.md#coded-capability-errors). `workspace:sidebar-command` additionally accepts `prune-worktree` with exactly `kind`, `repository` and `worktree`; main owns its [filesystem checks](worktrees.md#pruning-stale-worktrees).

`setup:restart-update` accepts no arguments from a registered board main frame.
It enters normal quit only when a stable macOS update is downloaded and checking
is enabled. `SetupState.updates` carries a fixed status enum and nonnegative
running-agent count, validated by preload; it never contains remote text or URLs.

## Window move IPC (#950)

Registered board main frames use `windows:list` (no arguments → bounded live
window ID/label list), `windows:begin-drag` (terminal/preview kind and ID → opaque
UUID), `windows:end-drag` (token), `windows:drop` (token and nullable tile/edge
placement), and `windows:move` (kind/ID and existing target window number).
Main sends `windows:drag` with only a token or null. `windows:prepare-move` carries
a UUID request and nullable placement, answered by `windows:move-ready` with that
request and a boolean from the requesting destination only. `windows:finish-move`
carries the same request and transferred kind/ID or null on refusal. The preload
validates and projects every reply/event. Tokens expire after 15 seconds and are
consumed before asynchronous work; renderer payloads never identify drag authority.

## Visible fact copy controls (#960)

Copy controls send identifiers, never clipboard text. Browser clipboard permission
remains denied. The value and its trailing small copy icon form one accessible
button; hover/focus reveals the faint icon and success replaces it with a check
for one second. Success adds no helper text; refusal uses `Unable to copy`.
No copy command is exposed through agent, remote-host or control transports.
Terminal IDs remain absent from remote process environments, arguments and files;
credentials, pairing codes, environment secrets and tokens have no copy control.

`workspace:sidebar-command` adds the following closed commands. Every copy payload
has exactly its declared fields, with bounded nonempty identifiers. The existing
registered board/main-frame/URL sender checks apply before dispatch.

| Kind | Identifiers | Main-owned resolution |
| --- | --- | --- |
| `copy-worktree-path` | repository, worktree | Existing canonical checkout membership check |
| `copy-default-branch` | repository, worktree | Authorized panel facts' default branch |
| `copy-worktree-branch` | repository, worktree | Current local checkout branch, or the registered remote placement's raw branch (without host decoration) |
| `copy-worktree-head` | repository, worktree | Full HEAD of a currently detached checkout; display stays seven characters |
| `copy-pull-request-number` | repository, worktree | Current tracked PR number |
| `copy-pull-request-url` | repository, worktree | Forge's host-validated current PR URL |
| `copy-remote-url` | repository, worktree | Authorized local panel facts; no fetch |
| `copy-session-id` | session ID | Existing validated agent conversation ID |
| `copy-foom-session-id` | session ID | Known Foom session's ID |
| `copy-parent-id` | session ID | Selected child's parent ID |
| `copy-child-id` | session ID, child ID | Selected parent's current child relationship |
| `copy-handoff-summary` | session ID, positive sequence | Selected session's current handoff, refusing stale sequences |
| `copy-error-text` | closed error sentence ID | Fixed sentence catalog in `shared/application-errors.ts`; arbitrary exception text is never accepted |

Local checkout fact copies authorize identity before resolution and again after
awaited reads. Remote branch copies resolve only a retained registered placement
bound to the selected local repository and a current session row on the same host;
main rechecks its host and approved folder registration, without local Git or SSH.
Missing facts, unknown checkouts/sessions, unrelated children and stale
handoffs refuse. Remote copies accept credential-free HTTP(S), SSH, Git and file
URLs, SCP-style remotes and absolute or explicit relative Git paths. URL queries
and fragments refuse because they may carry tokens. PR URLs retain the forge's
HTTPS/host check and allow normal web paths, including Gerrit's `+` paths.
Copying reads no file bytes, clipboard contents, credentials or provider state.

`setup:copy-host` invokes a void capability with exactly one `HostCopyCommand`:
`copy-host-alias` and `copy-host-code-folder` name a registered host;
`copy-checkout-path` names a registered repository and a host (null for Local).
Main resolves registrations and the last validated location observation without
SSH or network work, refuses absent observations and unregistered objects, and
checks that remote checkout paths remain under the registered code folder.
Checkout paths appear in Settings → Repositories → Locations; Hosts contains
aliases and code folders.

`preview:copy-path` invokes a void capability with one preview ID. The registered
owning board main frame is checked by the window router. Main resolves the full
opened path from that window's preview registry; closed, foreign and bundled
manual IDs refuse. The tile panel retains the relative display path.

The trusted confirmation bridge alone sends `confirmation:copy-path` with the
pending request ID, a displayed removal-path ID and a positive call ID. Main
requires the exact trusted dialog contents/main frame/URL and a presented pending
request, resolves only its worktree and displayed status paths (including rename
sources), and replies with `confirmation:copy-result` containing call ID and
boolean success. Stale requests and unknown paths fail without copying or
answering the confirmation. Preload validates replies and bounds pending calls;
a missing reply fails after three seconds. Pairing, disclosure and other facts
never become copy targets. Copy buttons join the dialog's existing focus trap.
