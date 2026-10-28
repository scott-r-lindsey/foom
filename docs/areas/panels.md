# Panels

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/sidebar.md).

Main panel facts remain in `workspace-context.ts`; sidebar dispatch is in `sidebar-commands.ts` and home-shell launch in `worktree-launch.ts`, all behind the Workspace facade.

## Sidebar panels and home shells (#197)

`PanelIntent` owns cancellable 400/120/250 ms hover timers, pinning and drag
suppression. The sidebar derives panel subjects and commands from its source;
`RowMenu` shares positioning, keyboard and main-owned confirmations between the
application menu and labelled sidebar dialogs. Panel facts load through the
source, ignore superseded replies and remain inert text. Session title edits
remain local view preferences. The theme subscription applies the validated
`panelColor` setting as root metadata; CSS forces undecorated panels for High
Contrast and increased OS contrast without weakening status outlines.

`workspace:panel-facts` accepts exactly a repository and worktree path from the
trusted top frame. WorktreeService validates registered membership and canonical
launch identity even on cache hits. Local Git reads use argument arrays and
three-second deadlines, and results are cached for three seconds per checkout
identity. Failed reads return null facts. The request never calls fetch: merge
comparison uses only the last successful default commit already fetched by the
cleanup service. Default-branch and last-fetch facts also read the local remote HEAD and FETCH_HEAD timestamp, including repositories with no linked checkouts. Sidebar eligibility supplies the same count used by cleanup.

Fact-copy actions use validated sidebar commands and main’s clipboard capability: home paths are main-owned, checkout paths require a registered checkout identity, and conversation IDs come from the selected session. Browser clipboard permissions remain denied.

`home-shell` is a path-free sidebar command. Main chooses the home directory and
shell, starts a normal sandboxed-host PTY and returns its created terminal ID for request-specific tile placement, recording `home: true` alongside
ordinary session metadata. Restore accepts home records only for shells with
matching home paths; previously running home shells restart when restore is enabled. Restart uses the same
main-owned launch path. Home sessions remain outside the Git repository tree
and repository-scoped agent control; no arbitrary cwd or executable capability
is added. The bounded shell version probe is main-owned and cached.

The read-only mockup reference is `docs/mockups/sidebar-panels.html`; its existing
README entry describes these panels. Contributor rules keep that reference
folder unchanged.
