# Control Input

## Child input (#629)

`prompt` accepts child `id`, `text` and `idempotencyKey`. The CLI spelling is
`foom prompt ID --text TEXT --idempotency-key KEY`. Text is 1–16384 UTF-8 bytes,
nonblank, rejecting control and format characters except newline and tab. Slash
commands are allowed. The host normalizes LF to CR, wraps the text in bracketed
paste markers when enabled in its headless xterm, then appends Enter.

`send_keys` accepts child `id`, `keys` and `idempotencyKey`. The CLI spelling is
`foom send-keys ID --keys down,enter --idempotency-key KEY`. Supply 1–64 keys from
`enter`, `esc`, `up`, `down`, `left`, `right`, `tab`, `ctrl+c`, `y`, `n`, `0`–`9`.
Validate the entire list before writing any bytes. Main and the utility host
validate the terminal ID and logical payload at every boundary; keys are encoded
only after validation. Both operations use the existing terminal input path.

Only the granted orchestrator's own non-taken-over children in its repository are
eligible. Foreign, human-owned, taken-over and unknown IDs are indistinguishable
(`not_found`); revoked roles are `forbidden`. Recheck the live principal and
ownership after durable audit intent, immediately before delivery. Idle, done after
a handoff, working and attention states all permit input; starting or exited
processes return `conflict`. Permission, credential and provider dialogs may be
answered without per-message human approval. No atomic, question-specific input
channel is required. The prior `reply` proposal flow and human reset budget are
removed. Take over and revocation end access; removal confirmation is unchanged.

Persist hashes only, never input text or key lists, with operation metadata in the
existing audit. Duplicate keys return the same operation without another write;
changed input with the same key returns `conflict`. After a lost response use
`operation_status` with the original key. Ambiguous delivery is `indeterminate`,
never automatically retried. Agent launch permission settings remain unchanged.
