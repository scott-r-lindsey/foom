# Image paste into agent terminals (#937)

**Approved decisions; implementation in progress.** The
[decisions on #937](https://github.com/scott-r-lindsey/foom/issues/937#issuecomment-6530141682)
(amending PR #944) govern this implementation. This implementation supersedes the
design-only PR #944; that PR can be closed by its owner.

## Current behavior and dependencies

Terminals carry input text. The renderer's
[`shell-controller.ts`](../../src/renderer/terminal/shell-controller.ts) forwards
xterm `onData` through the ID-scoped input bridge;
[`terminal-ipc.ts`](../../src/main/terminals/terminal-ipc.ts) owns sender, terminal
and attachment checks. Its existing clipboard capability is **write-only** copy on
select. Image paste needs a new, narrow read capability; it must not turn copy on
select into a general clipboard API.

[#936](https://github.com/scott-r-lindsey/foom/issues/936) landed in #945.
Keyboard paste and context-menu Paste invoke the same operation. Plain right-click
under mouse reporting remains the application's action; Shift+right-click selects
Foom's menu. Linux primary-selection/middle-click text paste remains governed by
[`middle-click.ts`](../../src/renderer/terminal/middle-click.ts), not this feature.

[#753](https://github.com/scott-r-lindsey/foom/issues/753) and its
[phase comment](https://github.com/scott-r-lindsey/foom/issues/753#issuecomment-6368668655)
require SSH-only transport, persistent remote sessions and host-local credentials.
The [Hosts rules](../areas/hosts.md) describe shipped registrations and management;
the former opening paragraph in [Terminals](../areas/terminals.md) saying there
was no Hosts setting predated that surface; this PR corrects it. Use the Hosts
rules and current code for this design. This note does not change the separate
#757 persistence roadmap.

## One explicit paste operation

Keyboard paste (the platform's paste shortcut) and context-menu Paste target the
live, visible, attached terminal captured at the gesture. Main reads the clipboard
only for that explicit action, never on focus, clipboard changes, hover, agent
requests or a background timer. No image-paste MCP tool is added.

- Nonempty plain text wins, including whitespace-only text, even if an image
  representation also exists. Preserve existing text paste and bracketed-paste
  behavior. Do not trim text to decide whether an image should be sent.
- With no text and an allowed raster image, capture one clipboard snapshot and
  prepare one file. An empty clipboard, unsupported representation or file-list
  clipboard does not cause Foom to read arbitrary files. Multiple image items are
  refused in the first version rather than silently choosing one.
- Main resolves the destination from the session's recorded launch placement,
  never a renderer-supplied host, path or current mapping. Reject ordinary shell
  sessions in the initial agent-only feature; guessing the foreground program
  cannot establish an agent capability.
- Keep the terminal ID and attachment generation through validation, upload and
  paste. Recheck ownership, liveness and the original attachment before inserting.
  Switching tiles, closing the session or losing the connection cancels delivery;
  a delayed result must never appear in another terminal.
- Insert exactly `[pasted image '<absolute path>'] ` (with recipient quoting and
  trailing space) as one xterm paste, with no Enter, command or
  automatic prompt submission. Preserve bracketed paste and ordinary input
  accounting. Serialize repeated paste operations per session. Do not fall back to
  raw Ctrl+V or replay interrupted input after failure. Show a fixed, bounded error
  and let the user retry explicitly.

The renderer requests the operation through a sandboxed, typed preload bridge;
main validates the registered board main-frame sender and ID as for terminal
input. Renderer code does not import Electron/Node or receive image bytes, arbitrary
filesystem access or a reusable clipboard reader. A one-use response may contain
only the insertion text for that ID/generation. File publication alone does not
prove delivery: cancellation after publication deletes the unused file where
possible, with session cleanup as the fallback.

## Formats, bounds and validation

Require **4 MiB per image**, enforced on encoded clipboard input where available,
normalized PNG output, local writes and remote upload. PNG, JPEG, WebP and GIF are
the only accepted encoded formats. Reject SVG, HTML, TIFF, PDF, URLs and arbitrary
file references. An OS-native clipboard bitmap is captured as raster pixels and
normalized to PNG; it does not authorize reading an encoded file of another type.
When only a native bitmap API is available, the OS may already have allocated its
bitmap before Foom can apply its limits; do not claim the byte cap bounds that OS
allocation.

Check magic bytes and the decoder's detected format, not only MIME or extension.
Use a maintained decoder with explicit dimension/allocation limits in an isolated
local worker/utility process: maximum 8,192 pixels on either axis and 16 million
pixels total, a 64 MiB pixel budget, and a five-second decode deadline. Refuse
malformed, truncated, oversized or unsupported data before writing a published
file. Do not execute a converter through the shell. The disposable main-owned Electron utility process uses pinned sharp/libvips,
with `limitInputPixels`, four input channels, first-page decoding, disabled caches,
one worker thread and strict corrupt-input handling. Main terminates it after five
seconds. Renderer code never receives image bytes. Native OS clipboard conversion
may already have occurred before Electron exposes its PNG representation.
See [sharp constructor bounds](https://sharp.pixelplumbing.com/api-constructor/).

Decode and re-encode to a fresh `.png`, apply orientation, preserve transparency,
and strip source metadata, EXIF/location data, comments and appended bytes. For
animated GIF/WebP/PNG, use a single first composited frame; disclose that paste
sends a still image. Refuse output over the cap instead of silently resizing or
lowering quality. The remote accepts only the resulting PNG, checks signature,
IHDR dimensions and exact size/hash, and stores those normalized bytes. It does
not need an Electron/image decoder or accept arbitrary encoded formats. Hashes
check transfer integrity; they are not proof that a malicious same-account writer
cannot alter a file later. Never log image bytes, clipboard text or content hashes.

## Storage, permissions and lifetime

Use a Foom-owned image root outside every checkout, with a fresh random directory
per **launch**, allocated lazily on first image paste:

| Placement | Proposed location |
| --- | --- |
| Local | `<os.tmpdir()>/foom-images-<account-key>-<profile-key>/<random-launch>/image-<random>.png` |
| Remote Linux/macOS | `<remote-home>/.foom-host/images/<random-launch>/image-<random>.png` |

The account key separates local users; it grants no authority. Launch and file
names use cryptographic random identifiers unrelated to terminal IDs, conversation
IDs, tokens, repository names or clipboard filenames. A resume creates a fresh
launch directory. Never place images in the repository or beside MCP/hook secrets,
and never expose the daemon's takeover ID in filenames or manifests.

On POSIX, require 0700 directories and 0600 regular files, current-user ownership
and one hard link. Create files exclusively, refuse symlinks and unsafe parents,
check containment/identity at use, and publish by rename inside the private launch
directory only after a complete write. On Windows require the current-user-only
protected DACL and reject reparse points, following
[`private-files.ts`](../../src/node-common/private-files.ts) and
[`private-file-permissions.ts`](../../src/node-common/private-file-permissions.ts).
Those main/CLI helpers cannot be imported into terminal-host: the remote follows
its own [`private-path.ts`](../../src/terminal-host/remote/private-path.ts) checks.
An insecure pre-existing root fails closed; do not chmod someone else's directory
or repair an unexpected link. Owner-only files protect against other accounts,
not agents running as the same user, administrators or a compromised host.

Keep at most **16 files / 32 MiB retained per launch**, reserving quota before
write/upload; refuse the next image instead of evicting one still referenced by a
prompt. Delete on natural agent exit, explicit Stop/Close, failed launch and local
shutdown after the agent stops. Hiding/detaching a tile does not close a session.
Remote SSH loss or hub quit must not delete images from a still-running remote
session; cleanup belongs to the daemon alongside its actual session disposal.
See session expiry/disposal in
[`daemon.ts`](../../src/terminal-host/remote/daemon.ts), including today's 24-hour
detached-session grace.

There is no creation-age expiry. Files remain until their session closes. Startup
purges leftover generated launch directories from crashes, in bounded batches that
yield between batches. The local temp root is account- and profile-specific, so
starting Foom Dev cannot delete a different profile's live images. Remove interrupted
`.partial` files on failure. Cleanup visits only generated direct children and
refuses unsafe entries. Failures produce fixed content-free diagnostics. This is
not secure erase; backups, agent copies and provider retention are outside cleanup.
A later resumed conversation may refer to files deleted when its old session closed.

## Remote upload: extend existing SSH management

The actual current path is:

1. [`remote-bootstrap.ts`](../../src/main/terminals/remote-bootstrap.ts) selects
   and verifies the matching SEA artifact and builds fixed SSH argv. Bootstrap
   already streams that artifact through SSH stdin, then executes `foom-host
   --connect`. Keep BatchMode, disabled forwarding, host-key trust and the existing
   environment allowlist. Image data must not be interpolated into this bootstrap
   shell script or sent as a command-line argument.
2. [`remote/main.ts`](../../src/terminal-host/remote/main.ts) connects stdin/stdout
   to the private 0600 Unix socket and starts the persistent daemon if necessary.
   The daemon negotiates the exact build hash before accepting operations.
3. [`remoteManagement`](../../src/main/terminals/remote-transport.ts) currently
   opens one bounded management connection without a PTY, sends a `manage` request
   after `hello`, receives `managed`, and closes it. The daemon dispatches to
   [`manageHost`](../../src/terminal-host/remote/management.ts).
   [`HostManagement`](../../src/shared/registered-hosts.d.ts) currently has only
   inspect/repository/clone/worktree operations and **no upload**. Those operations
   have no terminal ID and are code-folder-scoped; they cannot be reused unchanged
   for session-owned files.

Add a closed, session-scoped **image-put** management operation over that same
SSH/stdio/socket path, with corresponding runtime request/result validators.
Do not use scp, SFTP, a new listener, agent forwarding, shared mounts or cloud
storage. Dispatch this variant separately from code-folder operations: it neither
probes agents nor clones anything nor accepts a destination directory.

The hub supplies the terminal ID, live launch generation, opaque owner capability,
random upload ID, normalized byte count, SHA-256 and bounded base64 PNG bytes. Mint
the capability at session creation, retain it only in hub/daemon memory, bind it
to the current owning connection generation, rotate it on takeover, and revoke
it on close. Never pass it to the agent or put it in a file. The daemon validates
an existing live agent session before decoding, reserves its quota, chooses the
private path itself, writes a 0600 `.partial` exclusively, verifies bytes/hash,
then atomically publishes. Recheck generation/liveness before publication and
before replying. A management connection must not create or take over a PTY.
Close races serialize with publication and cleanup, so upload cannot recreate a
closed session's directory. Keep image operations out of host-enrollment IPC.

[`remote-host-protocol.ts`](../../src/shared/remote-host-protocol.ts) previously
used protocol 2 and an **8 MiB UTF-8 frame cap**. A 4 MiB file expands to about
5.34 MiB in base64, leaving room for a small bounded envelope in one frame. Reject
oversized frames before JSON/base64 allocation and enforce canonical base64 and
decoded size. Do not raise the frame cap or reuse screen-response fragmentation
for uploads; it is currently a response-only mechanism. Use protocol 3, with a protocol revision
and exact-build fixtures/catalog validation for the extension rather than silently
accepting new fields in protocol 2.

Keep one upload in flight per host and one per session. The daemon currently
allows four pending connections with a ten-second acceptance deadline. An
accepted, validated image request needs a bounded exception: use at most
60 seconds for that management operation, within the transport's existing
separate 120-second bootstrap budget (#947). Do not relax deadlines for all pending connections
or hold unbounded queues. Timeouts, partial writes, disconnects and invalid replies
publish no path to the terminal. Delete partials; a lost success reply can leave
an unreferenced completed file until session cleanup. Do not automatically
retry or paste after reconnect; a new explicit paste receives a new upload ID.

The result is a bounded host-generated absolute remote path, upload ID and launch
generation. Main checks its expected host/session, generated path shape, lack of
control characters, canonical single file component and result fields before
returning insertion text. A remote path is never opened on the hub or treated as
a local path. Images are normalized in memory on the hub; there is no need for a
second local staging file for remote paste. Credentials and SSH keys stay on
their original machines. Remote Pi/OpenCode launch support landed in #946. Image upload still requires
the same supported-agent gate: Pi has a passing check, OpenCode does not. It never
bypasses launch/discovery restrictions in
[`agent-launch.ts`](../../src/terminal-host/remote/agent-launch.ts).

## Path serialization and agent behavior

Insert an absolute filename with no newline, NUL, terminal escape or trailing
Enter. Names Foom generates use a restricted ASCII alphabet, but ancestors may
contain spaces and punctuation. Never use a shell to create, upload or quote a
file; quoting is only text serialization for the recipient.

| Recipient shell dialect | Literal path representation |
| --- | --- |
| POSIX sh/bash/zsh | Single-quote the whole path; replace each `'` with the standard close-quote, escaped apostrophe, reopen sequence: `'a'\''b'`. |
| fish | Single-quote the whole path; escape backslashes as `\\` and apostrophes as `\'` inside it. |
| PowerShell | Single-quote the whole path; double embedded apostrophes: `'C:\a''b\image.png'`. No `&` invocation prefix. |
| cmd.exe | Double-quote paths with spaces; refuse paths containing `%`, `!`, quotes, CR/LF or other expansion/control syntax. Do not claim double quotes prevent percent/delayed expansion. |
| Unknown/custom shell | Refuse image paste until a tested literal-path serializer exists. |

Use main-owned launch facts for the shell dialect, with a host-reported validated
dialect for remote shell contexts; never infer it from untrusted output. Direct
agent TUIs receive quoted path **text**, not a shell command. Shell escaping does
not establish that a TUI parses quotes or attaches the file: verify that exact
insertion syntax separately before enabling it. In particular, an argument such
as `--image` cannot be retroactively appended to a running CLI's argv. Do not type
a new command, alter agent permissions or auto-approve a file read to compensate.

### Interactive hand checks (Linux, 2026-10-30)

A disposable working directory under `test-results/image-paste-interactive-fz5z3uc7/`
was used. A generated 64×64 PNG outside the checkout had yellow above cyan, with
an ancestor named `foom image's …`. Each running TUI received exactly one bracketed
paste of `[pasted image '/tmp/foom image'\''s …/sample.png'] `, then a harmless
request to name the top/bottom colors without commands, configuration or credential
access. Enter was sent separately. Foom and parent-agent credentials were scrubbed
from the environment; no bypass flags or configuration/credential inspections or
edits were used. Ordinary CLI credential handling remained the CLI's responsibility.

| Agent / installed version | Interactive result | Enablement |
| --- | --- | --- |
| Claude Code 2.1.314, Opus 5.5 | Resolved the literal path, requested normal Read permission; one-time approval, then “Top: yellow. Bottom: cyan.” | Enabled. Foom never approves reads on behalf of the user. |
| Codex 0.163.0, gpt-6.1-sol | Read-only sandbox, `--no-alt-screen`; Viewed image, then “Yellow, cyan.” | Enabled. |
| Pi 1.4.0, gpt-6.1-sol | `--no-session --model gpt-6.1-sol`; discovery of extensions/MCP/context/skills disabled; Read tool, then “Yellow, cyan”. | Enabled. |
| Copilot, OpenCode, Antigravity | No passing exact interactive check in this implementation. Optional retries were not used. | Unsupported. |
| Shells and config providers | No declared bundled image-paste recipient. | Unsupported. |

These Linux checks establish file-reference prompting, not automatic attachment or
cross-platform certification. Windows ancestors use PowerShell literal quoting;
POSIX ancestors use POSIX literal quoting. Remote Linux/macOS paths are serialized
as POSIX references. Neither mode invokes a shell. Automated tests use fixtures only.

### Earlier noninteractive evidence (historical)

### Hand checks (Linux, 2026-10-29)

All six [bundled manifests](../agent-plugins.md#complete-manifests) were inspected.
They declare launch/prompt/resume and hook/MCP features, not a universal interactive
image-path capability. The following are manual CLI checks, not automated tests
or cross-platform/remote certification. No agy invocation was made. No configuration
or credential files were inspected or edited by the investigator; ordinary CLI
credential handling remained the CLI's responsibility. No bypass flags were used.

A disposable directory under this worktree's ignored `test-results/` held a generated
64×64 PNG named `sample.png`, yellow in its top half and cyan in its bottom half.
From that directory the prompt was: “Inspect the image at <absolute sample.png>.
Name the color of the top half and the bottom half. Read only that image if needed;
do not run commands, change files, read configuration, or access credentials.
Answer the two colors only, or say unable if unavailable.” The colors were absent
from the filename and prompt. Foom credentials were removed from the child
environment. Each check was bounded; the successful commands below exited zero.

| Bundled agent / installed version | Hand-check command and result | What a pasted path establishes |
| --- | --- | --- |
| Claude Code 2.1.314 | `claude -p --no-session-persistence PROMPT` returned “Top: yellow. Bottom: cyan.” | A plain path in a natural-language prompt can lead to image reading. This does not prove automatic attachment on interactive paste. |
| Codex 0.163.0 | `codex exec --skip-git-repo-check --sandbox read-only PROMPT` returned top yellow / bottom cyan. Help separately advertises `--image FILE` for initial attachments. | Plain path prompting worked in this read-only check. `--image` is separate from pasting into an already-running TUI. |
| Pi 1.4.0 | Default `pi --no-session -p PROMPT` failed because its selected model was unavailable. `pi --no-session --model gpt-6.1-sol -p PROMPT` returned “Yellow, cyan.” Help also gives `pi @image.png MESSAGE`. | Plain path prompting worked with an available model. Help's `@file` syntax is evidence of an explicit initial attachment interface, not proof of interactive paste parsing. |
| OpenCode 2.0.32 | `opencode --prompt PROMPT` in the initial red-image check entered its TUI but gave no confirmed completed answer before the 45-second stop. | Unverified: do not promise image consumption or automatic attachment. No global server/config changes were attempted to make it pass. |
| GitHub Copilot CLI 1.0.103 | `copilot -p PROMPT` in the initial red-image check failed with “No supported model available.” Help advertises `--attachment PATH` only for noninteractive prompts. | Unverified; that flag is not an interactive paste contract. No sign-in, model catalog or permission changes were attempted. |
| Antigravity (`agy`, bundled) | Manifest inspection only; running agy was explicitly excluded from this investigation. | Unknown. Its text prompt support does not prove image support. |

Raw command/help output and generated images stay untracked in the worktree's
`test-results/image-paste-handcheck-n4ztae3f/`; the PR records portable findings
here rather than committing images or machine-specific logs. The first red-only
smoke check used `red.png`; the two-color `sample.png` check above avoids inferring
success from a suggestive filename.

The proposal's blanket “agents accept a path as an image reference” therefore
needs qualification. Filesystem accessibility, model vision support, ordinary read
permissions and prompt interpretation all matter. A path can remain plain text,
trigger a permission request or fail. Before implementation is enabled for any
provider, repeat the exact **quoted interactive paste**, with no auto-submit,
spaces/apostrophes in ancestor paths, and an image outside the checkout on that
provider/platform. Current manual evidence verifies a narrower initial-prompt
workflow for three CLIs. Do not add an ID-based special case or claim all six
are supported from these checks; any future manifest capability needs its own
measured version/syntax gates through the shared provider engine.

## Privacy wording for implementation

Add a clearly scoped image-paste paragraph to [Privacy](../areas/privacy.md), like
the existing probe-screen disclosure, when the feature is implemented. Proposed
wording (not a declaration of current behavior):

> On explicit image-only Paste into an agent terminal, Foom creates a private,
> temporary image file and inserts its path. For remote sessions, Foom transfers
> the image over SSH only to the user's selected host. When the agent reads or
> attaches it, the image enters that agent's context and can reach its model
> provider under the agent's own settings and permissions. Foom makes no image
> model request itself. Hiding a tile or disconnecting SSH does not delete a live
> remote session's files. Foom removes its copies on session end with cleanup after restart for crash leftovers.
> Agent transcripts, provider retention and copies made by the agent are outside
> Foom's cleanup guarantee.

No first-use or disclosure dialog is shown. Document this behavior in privacy and
terminal area docs. Text paste is unchanged.
Do not imply that insertion alone uploads to the model immediately or that an
image is safe to share because metadata was stripped. Clipboard/image data and
paths must not enter diagnostics, action-log payloads, hook observations, handoffs,
telemetry or Foom model requests. A pasted path may naturally appear in the agent's
prompt, terminal echo, authorized tails or transcript; existing tail redaction is
not an image-content privacy boundary. Foom never silently watches the clipboard.

## Raw Ctrl+V alternative

For local Claude/Codex, Foom could send the terminal control byte `0x16` and let the
CLI own clipboard reading/attachment. That avoids Foom's decoder, file lifetime
and upload work for those local launches. It is not xterm's ordinary paste path,
which consumes clipboard text and sends text input. It needs explicit shortcut
routing, agent/version/platform verification and a context-menu equivalent; on
macOS the application's image shortcut may differ from the OS paste shortcut.
This investigation did not verify raw Ctrl+V attachment behavior.

The remote CLI cannot read the hub's desktop clipboard, so raw passthrough cannot
serve #937 across hosts. In a shell Ctrl+V can mean literal-next-character; routing
it based only on a foreground process name would be unsafe and inconsistent.
Other bundled agents need separate evidence. Offering both paths by default would
also give keyboard/menu paste different formats, privacy disclosures and lifetimes.
Do not use it as a silent fallback after a failed file upload. A separately chosen
local-only native-attachment action could be considered later.

## Implementation acceptance

Use fixture clipboard images and fixture agents only in automated tests, including
the fixture SSH host for management upload. Unit tests must cover text precedence,
format sniffing/decoding, corrupt/animated files, input/output/pixel caps, quotas,
permissions, symlinks/reparse points, exclusive publication, quoting and hostile
ancestor names, session cleanup and bounded sweeps. Protocol tests must cover
foreign IDs/generations, capability rotation/revocation, strict base64/hash/size
validation, frame limits, slow uploads, partials, disconnects, duplicate gestures,
close/publication races and lost acknowledgements without duplicate delivery.

Electron coverage must exercise keyboard and #936 menu paste on the correct
attached fixture terminal, bracketed paste without Enter, no text/image double
paste, unsupported-agent errors, text-only shell behavior, attachment switches,
local cleanup, remote path delivery and cancellation. Verify the unchanged security
boundary with the full runtime validation required by AGENTS.md in the eventual
implementation PR. The implementation PR includes runtime, unit and Electron verification.

## Decided product behavior

The #937 decisions approve labeled file references; enable only passing agents;
keep 4 MiB, 16 MP, first-frame and 16-file/32 MiB limits; delete on session close
plus startup purge; refuse shells; show no disclosure dialog; and share the paste
operation with #936. There are no unresolved product questions in this note.
Remote management stays within #947's budgets and abort handling. The implementation
PR remains draft pending human approval of its untracked UI screenshots and goes
to the user to merge because it changes the SSH transport.
