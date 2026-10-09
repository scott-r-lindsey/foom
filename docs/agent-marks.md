# Agent marks in the sidebar

Research for [#112](https://github.com/scott-r-lindsey/foom/issues/112), checked
2026-10-03. It records published terms and Foom's choices. It is not legal advice,
and no vendor was contacted, so nothing here is permission.

Keep the plain **CC / CX / AG** badges for now, with the full agent name available
to sighted and assistive-technology users. Use Foom's own **`>_`** for shells.

| Agent | Ship now | Candidate after the outstanding conditions are resolved |
|---|---|---|
| Claude Code | `CC` | A monochrome Claude Spark, which Anthropic would have to supply, with approval for this UI. The published Spark is orange (Clay) only |
| Codex | `CX` | An official Codex product icon if supplied with applicable terms; otherwise the official monochrome OpenAI Blossom, clearly labelled Codex |
| Antigravity | `AG` | The official One Color / White Antigravity icon pair, with Google's approval |
| Shell, including zsh, bash, fish and PowerShell | `>_` | Keep the generic glyph; show the actual shell name in text |

## Claude Code — Anthropic

The [trademark guidelines](https://www.anthropic.com/legal/trademark-guidelines)
require specific permission and advance approval of the materials. Anthropic
supplies the artwork and its size/spacing requirements. Color, font and proportion
changes are prohibited; backgrounds must preserve readability, surrounding space
is required, and trademark symbols must not be added. The use cannot suggest
endorsement or affiliation. Permission can be withdrawn.

The [newsroom](https://www.anthropic.com/news) links an official
[press kit](https://anthropic.com/press-kit), a ZIP of logos and headshots with no
license or terms file. Its Claude assets:

- **Claude Spark:** SVG and PNG in **Clay** (Anthropic's orange) only. There is no
  monochrome, black or white Spark.
- **Claude logo** and **Claude Code logo:** Slate, Ivory and One-color versions.
  These are wide lockups, unusable in a 15px badge.
- **Claude icon:** rounded and square app icons.

The Spark is the only mark simple enough for a badge, and its only published color
conflicts with Foom's first brand rule: orange and amber mean "needs you" and
nothing else. The guidelines forbid recoloring it. A Clay Spark next to a status
light would read as attention, so Foom can't use the published file even with
permission.

**Recommendation:** retain `CC`. If official marks are pursued, ask Anthropic for
a monochrome Spark in light and dark versions, and explain why Clay can't be used.
Ask for the minimum size, clear space, permission to distribute it in source and
binary form, and the attribution text in the same request. The guidelines give
`marketing@anthropic.com` as the contact for organizations with an existing
business relationship.

## Codex — OpenAI

OpenAI's [Design Guidelines and Marks usage terms](https://openai.com/brand/)
cover third parties and provide conditional, revocable permission. Logos must
relate to OpenAI services, remain unmodified, acknowledge ownership, stay less
prominent than Foom, and imply no endorsement. The Blossom cannot receive added
colors; prescribed clear space applies. Co-branded partnership materials require
approval.

The public page offers logo downloads but does not specify a minimum size small
enough for a badge. Its [full brand guide](https://brand.openai.com/) redirected to a
sign-in page. A public Codex-specific distributable icon or character with usable
size/spacing instructions was not verified; the [product site](https://openai.com/codex/)
is not an asset license.

**Recommendation:** retain `CX` until the asset and spacing are verified.
The official black/white Blossom is a company-mark alternative; keep the Codex
label. Confirm source/binary bundling terms and ownership acknowledgment before
adoption. Questions beyond the published cases go to `partnercomms@openai.com`.

## Antigravity — Google

The official [press assets](https://antigravity.google/press) offer PNG and SVG
product icons in Full Color, One Color and White, plus wordmarks and lockups.
Use the product icon, not Google's company logo or a Gemini mark. The press page
does not state minimum size, clear space or an application redistribution license.

Google's [product-icon guidance](https://partnermarketinghub.withgoogle.com/brands/google/branding-guidelines/how-to-show-googles-brand/)
says to request permission through Partner Marketing Hub. Its
[product compatibility guidance](https://partnermarketinghub.withgoogle.com/brands/google/use-cases/product-co-branding/)
allows contextual identification and explains when icons are useful, but does not
remove that approval step. The older Brand Resource Center links redirect to these
pages. They were read directly when the search browser timed out.

The [trademark rules](https://partnermarketinghub.withgoogle.com/brands/google/trademarks-and-terms/trademark-guidelines-for-proper-usage/)
require approved artwork and clear space, prohibit alterations, and reject implied
affiliation. **Recommendation:** retain `AG` pending approval of the sidebar and
offline/source distribution. Request the supplied One Color icon for light mode
and White icon for dark mode; do not convert the full-color artwork, tint, crop,
animate or add a glow. Get the minimum size and spacing with approval; the badge
slot is about 15px tall.

Google's compatibility guidance also requires a legal attribution line in an
appropriate place in the product. Use its
[legal-line generator](https://partnermarketinghub.withgoogle.com/tools/legal-line-generator/)
or the exact wording supplied with approval; do not invent a registered-trademark
claim or treat attribution as permission.

## Shells and fallback

Draw a small, original chevron and underscore, or use the literal `>_` in bundled
Geist Mono. Do not trace an existing terminal application's
logo. The original SVG needs no third-party artwork notice; the font option uses
the existing font notices. No shell-specific artwork is selected or cleared by
this note: the shell's software license alone is insufficient evidence about a
separate logo. Use text such as `Shell (zsh)` for all four shells.

Implementation in #117 selects **no third-party artwork**. CC / CX / AG are UI
shorthand, and shells use literal `>_` in bundled Geist Mono, covered by the
existing font notices. No image licenses or generated notices are added.

Unknown identities use `?` in the same slot, with their plain identity (or
“Unknown agent”) in the accessible row name and hover/focus preview. Newly
supported agents should receive a readable plain label and full name. Other
programs launched in a shell retain `>_` and the detected shell name. Renaming a
session never replaces its identity in the accessible row name or preview.

The shared badge uses a **20px-high slot**, a **16px visual target**, at least
24px width and 11px Geist Mono semibold. This supersedes the mockup's older
20×15px row badges and 22×17px menu badges. Rows, tile headers, menus and launch
buttons share the same component. The full identity appears in the sidebar's
existing hover/focus preview; shell launch labels and previews include the
detected shell name. Missing or withdrawn artwork must retain this text fallback
without moving the separate status light.
Use the existing badge fill/ink tokens at rest. Letter badges (`CC`, `CX`, `AG`,
`>_`) take the deep-accent fill and a soft accent glow on menu hover and focus.
This is an interaction state, not status: amber, magenta and status tinting remain
off-limits. Respect reduced motion by disabling these transitions.

Official artwork keeps its own colors and is never tinted, glowed or animated;
any menu hover glow belongs on the badge slot behind the mark instead. Keep the
status light separate. Include the full agent name in
the row's accessible name and a hover/focus label when it is otherwise absent.
Check both themes and 80–150% interface scaling in the implementation. If a mark's
required clear space doesn't fit, keep the letters rather than shrinking it.

## Bundling and notices

This recommendation introduces no third-party image assets. Do not change notices
to claim a license for an image that Foom does not ship. Download availability,
an icon library's license, and a CLI's source license do not establish permission
for a vendor mark. Linking to an image instead of bundling it does not resolve
that question and would undermine Foom's offline UI and restrictive CSP.

For each subsequently cleared asset, keep its official source URL, retrieval date,
checksum, unmodified original, applicable terms and approval scope beside the
asset. Approval should cover the public source repository as well as Windows,
macOS and Linux packages. Bundle permitted files locally; do not fetch them at
runtime. Record any required review or withdrawal conditions so the fallback can
replace a mark if permission ends.

Feed required ownership acknowledgments, attribution and redistribution notices
into both `build/THIRD_PARTY_NOTICES.txt` and the offline About/Licenses view from
[#96](https://github.com/scott-r-lindsey/foom/issues/96). The build currently
aggregates only font notice files, so adding an image requires extending that
source of notices, not hand-editing generated output. Keep vendor artwork outside
Foom's Apache-2.0 claim. Suggested About copy: “Agent names identify
the software running in each session. Foom is not affiliated with or endorsed by
Anthropic, OpenAI or Google.”

## Follow-up

Implementation is tracked in
[#117](https://github.com/scott-r-lindsey/foom/issues/117): finalize the neutral
badges, original shell glyph and accessible labels after
the sidebar tree in [#113](https://github.com/scott-r-lindsey/foom/issues/113).
Official marks remain a separate asset-adoption decision with the conditions
above. About presentation coordinates with #96; missing permissions need not
block the neutral badges. No application or mockup changes belong in #112.
