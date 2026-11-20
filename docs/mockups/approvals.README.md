# One approval dialog · #1105

Open [approvals.html](approvals.html) in a browser. It is a clickable, offline
mockup using bundled Geist / Geist Mono and the Eclipse light and dark tokens in
[brand.md](../brand.md). The dashed controls above the board are review tools,
not application UI. All agents, repositories, paths, fingerprints and commands
are invented fixtures. No action reaches Foom, a terminal, SSH or an agent.

This is **phase 1 only**, proposed against [issue #1105](https://github.com/scott-r-lindsey/foom/issues/1105).
The issue and its complete comments feed were read; there were no comments.
The user must approve this mockup before implementation and merges this trusted
confirmation change. The current [confirmation behavior](../behavior/confirmations.md),
[security rules](../areas/confirmations.md) and [orchestration rules](../areas/orchestration.md)
describe today's serialized dialogs. This mockup proposes replacing that presentation
for agent/background approvals; it does not change production behavior or those
docs yet. Implementation must update the owning docs and add the issue's trusted
Electron regressions after design approval.

## Proposed surface

One trusted Foom approval window holds all pending agent/background requests,
including requests from different repositories. The HTML depicts that window
beside an illustrative board; it does not implement native trust isolation.
User-action confirmations such as opening a terminal link or closing a tile stay
beside that action and are outside this queue.

Each row names its origin, agent and tile when present (or explicitly says
background / no tile), repository, target, consequences and its own **Approve**
and **Decline**. Review details expand inside the row. The initial fixtures show
a clean removal, a removal that discards changes, an orchestrator grant, host
trust and plugin trust. These illustrate the disclosure layout; production must
retain the complete main-owned disclosures, identities, exact status snapshots,
plugin bytes/hashes and expiry deadlines, never substitute these abbreviated
fixtures. The console-pairing scenario represents a credential grant without
asking for a password.

The window grows with its contents to a proposed 720 CSS-pixel cap, constrained
by the available board area, then scrolls. Title and sidebar show the live count.
The header and footer remain visible. **Hide** (or Escape inside the queue)
keeps requests pending; the amber light and **N approvals waiting** reopen it.
There is no scrim blocking terminal input. Only explicit opening or interaction
moves focus into the window. A background arrival changes neither focus nor
scroll position and never captures Enter from the terminal. The queue is nonmodal;
Tab follows its controls without trapping someone away from the board.

New rows append at the end, with both row buttons disabled for a proposed 900 ms.
Repeated requests with the same kind, origin and subject join one row with a
repeat label. Production identity/deduplication must be main-owned, not a match
on display strings. Withdrawal, expiry and resolution remove only their own row;
resolving the last row hides the window. If removal deletes a focused control,
focus moves to Hide, or to the terminal when no requests remain. A background
removal does not move focus away from a surviving target.

The historical HTML still demonstrates **Approve all visible removals (N)**.
The [production rule](../behavior/confirmations.md) changed in #1293.
**Approve all clean removals (N)** captures all ready clean removals
regardless of scroll position. Removals with tracked changes or untracked files
require individual approval, as do authority, plugin trust, host trust and
credential rows. Production captures the IDs at the start of the gesture and
revalidates each checkout before removal. The mockup preserves arrival order
and illustrates the original visibility rule.

## Review walkthrough

1. Use **Light** and **Dark**. Scroll to the trust rows and expand **Review details**.
   Each request has its own decisions. Reset restores five requests.
2. Press **New removal** with the first rows visible. Existing rows stay put;
   scroll to the end immediately to see disabled arrival buttons, then enabled
   buttons after 900 ms. The title count increases.
3. Press **Repeat first request**. The count stays the same and the first row
   gains a repeat label. **Withdraw first request** removes it. **Expire host
   trust** demonstrates a request expiring without an answer.
4. To see the historical behavior, reset and press **Approve all visible removals**.
   Only fully visible ready removals disappear. Add another removal to see it
   remain pending. Scroll until a removal is partly clipped to see the count drop.
5. Hide the queue and reopen it using the amber waiting indicator. Reset, press
   **Arrival while typing (2s)** and keep typing into the mock terminal. The
   request arrives while the queue stays hidden; input and focus stay in the
   terminal. Enter does not answer a pending request.
6. **Credential request** appends read-only CLI pairing. It is individual and
   expires after 60 seconds even when hidden. Reset clears the fixture; old
   expiry callbacks cannot dismiss new rows.
7. Try a narrow viewport and browser zoom at 150%. The queue scrolls within its
   cap, long subjects wrap and all decisions remain reachable. No motion is
   needed to understand any state.

## Review evidence

Light and dark screenshots are captured under the worktree's ignored
`test-results/1105/` directory and listed in the phase-1 handoff. Images are not
committed or embedded as repository-hosted PR evidence. Keep this file and HTML
as reference material: do not import, lint, test or package the mockup.
