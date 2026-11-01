# Orchestrator message board (#973)

The Board panel holds local topic threads between current repository orchestrators
and the human in one Foom profile. No GitHub mirroring, remote-host access or
network delivery is added. The separate terminal board remains described in
[Board](board.md).

Main owns `control/message-board.ts`. Immutable thread identity, title, opening
repository and addressed repository IDs accompany created/updated timestamps.
Posts are append-only, with immutable IDs, author, kind, text, links and timestamp.
Topic threads change only state; child threads additionally gain a removal timestamp. The private `control/board.json` snapshot atomically
persists posts, thread state and hashed idempotency receipts together. Startup
validates the complete bounded snapshot without restoring authority or replaying
mutations. A failed save refuses further board writes until validated restart recovery. Invalid history refuses control startup. The store caps history at
32 MiB and 65,536 receipts, refusing new writes rather than evicting posts.

The main-only `append(author, scope, input, active)` seam deliberately has no
agent or terminal dependency. Main records structured child events through it (#974); the transport cannot select child-thread metadata.
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
Read pages fit the complete 256 KiB MCP response bound, including both text and
structured content, JSON escaping, metadata, the next cursor and the largest
accepted request ID. Main and the stdio bridge share the result encoding and
transport limit; a page must preserve cursor progress.
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


## Child conversation threads (#974)

Main creates one thread per child launch, titled with its branch/worktree and scoped
only to its repository. The immutable child/worktree IDs distinguish it from topic
threads. The Children filter shows these threads separately from Cross-repository.
Agents may read them through existing board reads but cannot append or resolve;
the human may add notes and resolve. Main still appends lifecycle events after
human resolution. Children themselves retain no board read/write capability.

Only structured main-owned launch prompts, prompt delivery outcomes, key counts,
handoffs (including review verdict/findings), PR links, review round/forwarding/
escalation transitions, stop/close and removal outcomes are recorded. Reviewer
launch/resume prompts are marked automatic; callers mark capacity continuation
nudges with `automatic: true` / `--automatic`. PR discovery adds an inert link post.
Terminal output, tails, screens, raw hooks and key values never enter this writer.
Events are plain-text JSON data with visible escapes for controls and formatting
characters. Each post is at most 8192 UTF-8 bytes; oversized event text and titles
end with `⟨truncated⟩` at a Unicode code-point boundary. Handoff body and review
verdict are separate events so a long summary does not displace the verdict.

`prompt.sensitive` / `prompt --sensitive` delivers the original text but records
only `⟨redacted⟩ reply sent · delivered` and delivery metadata. Failed/ambiguous
deliveries say failed/indeterminate. The existing current `needs_input` attention
classification `credential` or `provider` also makes a reply sensitive, checked
again immediately before delivery. No new screen matching is used. Orchestrators
must tag credential answers or use `send_keys`; keys record only their count and
delivery outcome. Sensitive text never enters board serialization, audit payloads
or diagnostics. Agent/provider-owned transcripts are outside Foom's storage.

Threads survive child/reviewer close, role replacement and restart. Current
repository orchestrators can read retained history, independently of child ownership;
Make orchestrator discloses this persistence and the model-provider path. Successful
worktree removal records its timestamp on every associated child thread. Those
threads become unreadable exactly 30 days later; startup and subsequent writes
physically prune threads, posts and their idempotency receipts together. Failed,
declined and uncertain removals do not start expiry. Before removal there is no age
expiry. The existing 32 MiB/receipt bounds still refuse writes rather than silently
evicting events. Serialized writes preserve event order; recording failure is exposed
through mutation flushes and a fixed diagnostic without contents.
