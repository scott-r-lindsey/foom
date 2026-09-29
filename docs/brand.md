# Brand

The direction is **Event Horizon: Eclipse**. It's a black hole with a glowing ring. The flat-then-vertical curve is also the rocket's flight path. The name is a wink at "foom", the hard-takeoff idea.

## Rules

1. **Amber means "needs you" and nothing else.** No amber or orange in the logo, marketing, or decoration.
2. **The black hole is always black** (`#06050B`), in both modes. Only the sky around it changes.
3. **Magenta (redshift) is only for failures.**
4. **Brand violet is for activity and identity**, never for a status that needs action.
5. **Status never depends on color alone.** Failed is square. Needs you has a halo.

## Color

| Token | Dark | Light | Use |
|---|---|---|---|
| `bg` | `#05040A` | `#F3F0FA` | App background |
| `surface` | `#0D0A17` | `#E9E4F5` | Rows, panels |
| `line` | `#251D3F` | `#DDD6EE` | Borders |
| `ink` | `#F4EFFF` | `#14101F` | Text |
| `muted` | `#9D93BD` | `#625A7A` | Secondary text |
| `accent` | `#9B6BFF` | `#5B2BD9` | Brand, working light |
| `accent-deep` | `#7A3CFF` | `#3B1A99` | Glow, art |
| `attention` | `#FFB23E` | `#D98200` | Needs you only |
| `done` | `#6FE0A3` | `#13804A` | Done |
| `failed` | `#FF2E88` | `#D6166E` | Failed only |
| `hole` | `#06050B` | `#06050B` | The black hole, both modes |

Light mode uses a darker amber so "needs you" still wins against a pale background.

## Type

| Role | Face | Use |
|---|---|---|
| Display | Archivo Black | Wordmark, headlines. Never in dense UI. |
| Voice | Courier Prime | Taglines, empty states, marketing |
| Interface | Geist, Geist Mono | App UI text; Geist Mono for terminals, rows, data |

All four are under the SIL Open Font License. Bundle them with the app. Don't load them from a CDN: the renderer CSP blocks remote fonts, and the app must work offline.

## Mark

The wordmark is "foom", with the middle "o" drawn as the black hole. The app icon is the black hole with the curve passing it. Production needs a vector master and platform icon sets (`.icns`, `.ico`, PNG sizes).

## Voice

Calm, a little ominous, amused. Short reasons, no exclamation points.

- "Nothing needs you. Yet."
- "Takeoff was faster than expected."
- "3 agents past the knee."

Mockup: [docs/mockups/brand.html](mockups/brand.html). Only the Eclipse variant was picked.
