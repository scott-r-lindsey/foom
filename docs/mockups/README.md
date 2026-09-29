# Mockups

Clickable HTML mockups from the design phase. Open them in a browser; each is a single self-contained file. They are reference material, like `inspiration/`: never import from them, lint them, test them, or package them.

| File | Shows | Use it for |
|---|---|---|
| [board.html](board.html) | The main board: rows grouped by repo, lights, reason lines, peek, open, the waiting queue, `N`, and New worktree | Layout, interaction, and how the board feels with many agents |
| [first-run.html](first-run.html) | The preflight countdown: Agents (T-3), Repositories (T-2), Evaluator (T-1), Go / no-go (T-0), then an empty board | Flow, copy, and step structure for #17 |
| [brand.html](brand.html) | The chosen brand direction, Event Horizon: Eclipse, in light and dark | The look: color, type, icon, wordmark, and how the app should feel |

## What wins when they disagree

The docs are the spec; the mockups show intent. When a mockup and a doc disagree, follow the doc.

- **Look:** `board.html` and `first-run.html` were drawn before the brand was chosen. Their grey and indigo palette and their fonts are placeholders. Take layout and behavior from them, and color and type from [brand.md](../brand.md), `src/renderer/tokens.css`, and `brand.html`.
- **`brand.html` shows several variants.** Only Eclipse was picked (icon, wordmark, app look, and the light palette). The others were rejected.
- **Signals:** `board.html` shows "tty echo off" as a password signal. Research in [agents.md](../agents.md) rejected echo-off as an independent signal. Reasons and signals follow [product.md](../product.md) and the evaluator.
- **Fonts:** the mockups load fonts from Google Fonts. The app bundles its fonts and its CSP blocks remote ones.
- **Scope:** anything a mockup shows that no doc or issue describes (for example `⌘K` in `first-run.html`) isn't decided. Ask before building it.
