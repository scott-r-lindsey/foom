# Console

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Console

**Console helper and pairing implemented in #154.** `src/cli/` bundles as a Node 24
console SEA; `src/node-common/` supplies bounded private discovery and validators
to both console and main, without exposing Node to renderer/shared browser code.
An exact protocol and instance envelope routes online commands to the same service.
A separate `/control/v1/pair` endpoint accepts no bearer credentials, rejects browser
origins and nonliteral hosts, bounds bodies to 4 KiB, and holds the response while
the trusted main-owned dialog reviews a matching code. Pairing chooses the focused
live board at request time, or the first board; with no macOS boards it opens one.
The app-owned service never retains a closed board's dialog. Cancellation is
rechecked after opening a board and before requesting approval. Reviews expire after 60
seconds and support cancellation while queued or visible. Repository membership is
checked before and after review. A `cli` principal has read-only metadata scope,
a ten-minute deadline checked on every call, memory-only token delivery, and an
explicit release operation unavailable to agents. Pairing is single-pending,
rate-limited to one request per ten seconds and bounded to four live grants.
See [console usage and PATH ownership](../contracts/console.md#console-helper-and-local-pairing-154).
`foom config validate <path> [--json]` (#206) is offline and read-only. It dispatches
before inherited control credentials or pairing; it never opens discovery, keys,
worktree state or userData. The standalone Node executable needs neither Foom nor
a display, and also works while Foom is running. There is no config mutation.

The path names one file, a config root, `themes`, `terminal-themes`, `agents`,
`forges`, `sounds`, or one sound-kind folder. JSON files select their parser with
`kind`; folder validation also checks placement (`settings.json`, `themes/*.json`,
`terminal-themes/*.json`, `agents/<id>.json`, `forges/<id>.json`). Agent and forge
manifest filenames must match their validated IDs. Agent validation also replays
saved screen captures; config-root traversal checks the supported built-in captures.
See [capture/replay](../contracts/agent-report.md#saved-screen-rule-regressions-592).
Only the documented config layout is walked. Unexpected entries, symlinks (including
in-folder links), nonregular files and redirected directories are rejected. Reads
use capped open descriptors, carry the validated parent identity through each read,
and check it again after opening and before/after reading. JSON is
limited to 64 KiB and theme folders to 50 entries; sound kind folders to 100 entries,
with 8 MiB Working files and 2 MiB other files. Invalid entries count toward these
offline traversal bounds so hostile directories cannot force unbounded work.

Diagnostics contain a filename, JSON path and fixed reason from the validation
vocabulary, with optional warning severity and fixed detail. Text prints one
diagnostic per line, followed by sanitized agent capability and warning summaries;
filenames are JSON-escaped to keep control characters inert. `--json` prints an
object with `problems` and `agents` arrays, for example
`{ "problems": [], "agents": [] }` for valid input without agent summaries. Agent
entries include the validated ID, capability facts and warnings, matching the text
summaries. Exit status is 0 for valid input (including warnings), 1 for invalid and
2 for usage or I/O errors; I/O errors take precedence in mixed results. No file
contents or parser exception messages appear in diagnostics. Offline sound checks use the
shared filename, header, size and duration rules; `music-metadata` reads duration
from bounded bytes through a tokenizer that checks token lengths before allocation.
FLAC block and comment counts are checked before the parser can allocate tag arrays,
with no file/network access. Missing duration is invalid.
This checks container metadata, not sample decoding; playback still verifies that
Chromium can decode the audio and checks its samples.
