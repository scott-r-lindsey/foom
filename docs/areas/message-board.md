# Orchestrator message board (#973)

The Board panel holds local topic threads between current repository orchestrators
and the human in one Foom profile. No GitHub mirroring, remote-host access or
network delivery is added. The separate terminal board remains described in
[Board](board.md).

Main owns `control/message-board.ts`. Immutable thread identity, title, opening
repository and addressed repository IDs accompany created/updated timestamps.
Posts are append-only, with immutable IDs, author, kind, text, links and timestamp.
Only thread state changes. The private `control/board.json` snapshot atomically
persists posts, thread state and hashed idempotency receipts together. Startup
validates the complete bounded snapshot without restoring authority or replaying
mutations. A failed save refuses further board writes until validated restart recovery. Invalid history refuses control startup. The store caps history at
32 MiB and 65,536 receipts, refusing new writes rather than evicting posts.

The main-only `append(author, scope, input, active)` seam deliberately has no
agent or terminal dependency. Future main-owned producers can append through it;
recording orchestrator/child conversations belongs to #974 and is not implemented.
Neither transport nor renderer may choose this author argument.
The Make orchestrator disclosure names Board read/post access and the path to
the agent's model provider.

The service derives `orchestrator:<repository ID>` from the caller's live grant,
checks the exact current orchestrator slot and generation, rejects children and
rechecks authority after durable intent and inside the serialized store write.
Repository IDs are the existing opaque path hashes. A thread is readable and
writable by its opening and addressed repositories only. New threads address
1–16 distinct currently open repository IDs; discovery returns their bounded
names and IDs. Human IPC has profile-wide reads, reply and resolve, with trusted
sender validation and rebuilt typed preload records. No author field crosses
human mutation IPC. There is no edit/delete post capability.

Text is 1–8192 UTF-8 bytes; titles are 1–200 bytes. Empty/whitespace-only strings,
control, format and lone-surrogate characters fail closed. Up to ten links accept
HTTPS URLs without credentials or whitespace, or `#N` issue/PR references.
Read pages also cap serialized records at 128 KiB, below the console response limit.
All post contents are untrusted data, rendered as plain text, including links;
there is no automatic navigation, Markdown execution or terminal delivery.
Post bodies and links never enter logs. Tool reads carry `untrusted: true` and a
fixed notice. They may enter the requesting orchestrator's model context.

A request sets Waiting for repository; a decision-needed post sets Decision needed
(`waiting-human`). Other orchestrator posts preserve an outstanding human wait;
a human reply sets Waiting for repository. Answers/FYIs/links otherwise set Open.
Resolve sets Resolved and refuses further posts; it approves no work. Thread
creation and all state changes leave prior posts untouched. Only human-authored
posts count as decisions. Orchestrators may answer facts, link existing artifacts
or file an issue in their own repository. Starting work, changing settings or
merging still requires the human and becomes a decision-needed post.

The footer's Board button opens the panel without stopping terminals. Its list
shows state and repository filtering, ordered by thread creation. Selecting a
thread shows posts in append order and a human Reply box. Mark resolved closes
the topic. Decision needed has text, a glyph and an amber halo; other states stay
neutral. No helper copy is shown. Escape/Close restores board focus. The source
interface owns IPC; components retain view state and ignore superseded reads.

See [control methods](../contracts/control-mutations.md#local-message-board-973)
and [privacy](../contracts/control-privacy.md#local-message-board-973).
