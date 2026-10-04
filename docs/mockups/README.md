# Mockups

Clickable HTML mockups from the design phase. Open them in a browser; each is a single self-contained file. They are reference material, like `inspiration/`: never import from them, lint them, test them, or package them.

| File | Shows | Use it for |
|---|---|---|
| [board.html](board.html) | The main board: rows grouped by repo, lights, reason lines, peek, open, the waiting queue, `N`, and New worktree | Layout, interaction, and how the board feels with many agents |
| [first-run.html](first-run.html) | The preflight countdown: Agents (T-3), Repositories (T-2), Evaluator (T-1), Go / no-go (T-0), then an empty board | Flow, copy, and step structure for #17 |
| [brand.html](brand.html) | The chosen brand direction, Event Horizon: Eclipse, in light and dark | The look: color, type, icon, wordmark, and how the app should feel |
| [settings.html](settings.html) | Settings beside the persistent sidebar: Terminal, Appearance, Sound and Foom config, in light and dark | Layout and controls for #80–#84 and #86 |
| [sidebar.html](sidebar.html) | The sidebar as a tree: repository → worktree → session, with filter, pins, roll-up lights, ⋯ menus that open to the right, rename in place, and the empty pane; 50 repositories or one, in light and dark | Layout and interaction for the sidebar tree (#113), shared worktrees (#114) and resume (#115) |
| [tiles.html](tiles.html) | Several terminals at once: a split-tree layout with presets, split right and down, close, draggable gutters, maximize, tile numbers shared with the sidebar, and click-to-place with a refusal when full, in light and dark | Layout and interaction for #132 (drag and drop is #133) |
| [confirmations.html](confirmations.html) | Confirming without native dialogs: click again in the ⋯ menu for actions with nothing to review, and a trusted dialog window for removing a worktree with changes and for quitting with terminals running, in light and dark | Look and interaction for #128 |

## What wins when they disagree

The docs are the spec; the mockups show intent. When a mockup and a doc disagree, follow the doc.

- **Look:** `board.html` and `first-run.html` were drawn before the brand was chosen. Their grey and indigo palette and their fonts are placeholders. Take layout and behavior from them, and color and type from [brand.md](../brand.md), `src/renderer/tokens.css`, and `brand.html`.
- **`settings.html` uses the brand.** It was drawn after the brand and the sidebar decision (#88), so its colors are the tokens. Its Setup sections are placeholders for preflight's existing controls. Deep Field and the scheme list are proposals, and the terminal preview uses Hack Nerd Font Mono only if it is installed.
- **`tiles.html` supersedes the single pane** in `sidebar.html`. Its sidebar is a slice, without filter or menus, and it has no Preflight button: Preflight leaves the sidebar in #132.
- **`sidebar.html` uses the brand and supersedes the flat sidebar** in `settings.html` and `board.html`. Agent badges (CC, CX, AG, `>_`) stand in until #112 decides on marks. The terminal text is a picture, and the menu actions don't do anything.
- **`brand.html` shows several variants.** Only Eclipse was picked (icon, wordmark, app look, and the light palette). The others were rejected.
- **Signals:** `board.html` shows "tty echo off" as a password signal. Research in [agents.md](../agents.md) rejected echo-off as an independent signal. Reasons and signals follow [product.md](../product.md) and the evaluator.
- **Fonts:** the mockups load fonts from Google Fonts. The app bundles its fonts and its CSP blocks remote ones.
- **Scope:** anything a mockup shows that no doc or issue describes (for example `⌘K` in `first-run.html`) isn't decided. Ask before building it.
