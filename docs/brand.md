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
| `attention` | `#FFB23E` | `#D98200` | Needs you lights only |
| `attention-ink` | `#FFB23E` | `#8C5000` | Needs you text; readable on the row surface |
| `done` | `#6FE0A3` | `#13804A` | Done |
| `done-ink` | `#6FE0A3` | `#0E6B3C` | Done and GO text; readable on the row surface |
| `failed` | `#FF2E88` | `#D6166E` | Failed only |
| `failed-ink` | `#FF2E88` | `#B0105A` | Failure and NO-GO text; readable on the row surface |
| `hole` | `#06050B` | `#06050B` | The black hole, both modes |
| `badge-label-fill` / `badge-label-ink` | `#3A3060` / `#F4EFFF` | `#4A4263` / `#F4EFFF` | Label half of a data badge |
| `badge-fill` / `badge-ink` | `#1C1632` / `#F4EFFF` | `#D6CFE9` / `#14101F` | Value half of a data badge |

Light mode uses a darker amber so "needs you" still wins against a pale background. The separate text token meets small-text contrast requirements without dimming the attention light. `done-ink` and `failed-ink` do the same for green and magenta text.

Badges and chips use the badge fills and stay neutral: no amber, magenta, or status color. A card outlines at most one thing, such as an agent's signal.

## Interface themes

| Theme | Base | Palette |
|---|---|---|
| System | System | Eclipse Light/Dark follows the operating system |
| Eclipse Light | Light | Original pale violet surfaces and dark violet accent |
| Eclipse Dark | Dark | Original near-black violet surfaces and bright violet accent |
| High Contrast | Dark | Black surfaces, brighter text and status inks, visible neutral borders |
| Deep Field | Dark | Blue-slate surfaces with a violet accent |
| Moonlight | Light | Cool slate surfaces with a violet accent |

Themes are complete color-token data, not CSS. `src/shared/interface-theme.d.ts`
defines the version 1 schema: `{ version: 1, name, base, colors }`. `colors` contains
all 19 color tokens from `src/renderer/styles/tokens.css`, including `space-ink`;
font tokens stay fixed. Names contain 1–40 letters, numbers, spaces, dots, hyphens
or underscores. Every color is an opaque six-digit `#RRGGBB` value. Extra and
missing fields are rejected. `base` must agree with the background's lightness
(white has higher contrast than black on a dark background, and vice versa).

Built-in and future user themes share these enforced invariants:

- `hole` is exactly `#06050B`.
- Attention and attention ink have HSL hues 25–50°; failure and failure ink
  315–345°; accent and accent-deep 245–280°. Each has at least 45% saturation.
  Other tokens may not use the amber 20–55° or magenta 310–350° bands above 20%
  saturation. This keeps status colors out of decoration and preserves violet identity.
- Attention, failure and accent colors are separated pairwise by at least 40
  CIE Lab Delta E 1976 units, using sRGB and a D65 reference white. The same
  minimum applies to attention ink, failure ink and accent. This is Foom's design
  threshold, not a WCAG criterion.
- Primary text, muted text, accent and all three status inks meet **4.5:1** on both
  background and surface. Badge inks meet 4.5:1 on their own fills; space ink meets
  4.5:1 on the black hole. Contrast uses the
  [WCAG 2.2 relative-luminance calculation](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
- High Contrast raises the six text/ink roles to **7:1** and its border token to
  **3:1** against background and surface. Tests enforce this built-in promise.
- Status labels, the Needs you halo and the square Failed light remain visible;
  color is never the only signal. Real-app axe checks cover the board and Settings
  in every built-in theme.

Choosing System, Light or Dark in Appearance or preflight returns to Eclipse.
Changing interface size preserves the theme. Terminal schemes remain independent;
Follow interface follows the base variant. Native controls follow the theme's base,
and the native window background uses its exact `bg` token.

## Type

| Role | Face | Use |
|---|---|---|
| Display | Archivo Black | Wordmark, headlines. Never in dense UI. |
| Voice | Courier Prime | Taglines, empty states, marketing |
| Interface | Geist, Geist Mono | App UI text; Geist Mono for rows and data |
| Terminal | Hack Nerd Font Mono | Terminal output and Settings terminal preview; Geist Mono fallback |

The four UI fonts are under the SIL Open Font License. Bundle them with the app. Don't load them from a CDN: the renderer CSP blocks remote fonts, and the app must work offline.

Hack Nerd Font Mono bundles only Regular and Bold from Nerd Fonts. Installed Hack Nerd Font Mono italic and bold italic faces are preferred for italic terminal output; otherwise Chromium synthesizes italics from the bundled faces. The Mono variant keeps Nerd Font icons in one cell. Nerd Font logo glyphs are not used in Foom’s own UI. Font provenance, checksums, and licenses live in `src/renderer/fonts/README.md` and the packaged third-party notices.

## Mark

The wordmark is "foom", with the middle "o" drawn as the black hole. The app icon is the black hole with the curve passing it. Production needs a vector master and platform icon sets (`.icns`, `.ico`, PNG sizes).

For third-party agent identities, see the [agent-mark research](agent-marks.md):
recommended sidebar fallbacks, official asset sources, permission conditions and
notices for future asset adoption.

## Voice

Calm, a little ominous, amused. Short reasons, no exclamation points.

- "Nothing needs you. Yet."
- "Takeoff was faster than expected."
- "3 agents past the knee."

Mockup: [docs/mockups/brand.html](mockups/brand.html). Only the Eclipse variant was picked.
