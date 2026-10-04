# Agent marks in the sidebar

Research for [#112](https://github.com/scott-r-lindsey/foom/issues/112), checked
2026-10-03. This records published permissions and Foom's recommendation, not a
legal opinion or permission obtained from a vendor. No vendor was contacted.

Keep the plain **CC / CX / AG** badges for now, with the full agent name available
to sighted and assistive-technology users. Use Foom's own **`>_`** for shells.
The following are Foom display choices, not vendor-approved logos or minimum sizes:

| Agent | Ship now | Candidate after the outstanding conditions are resolved |
|---|---|---|
| Claude Code | `CC` | An Anthropic-supplied monochrome Claude spark, with approval for this UI; prefer the simple mark to a character |
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
[press-kit ZIP](https://anthropic.com/press-kit). Its contents could not be inspected
in this research (the direct download returned HTTP 403); no asset-specific license
or monochrome variant was verified. A press download is not evidence of approval
for Foom's distributed application.

**Recommendation:** retain `CC`. Request the Claude spark rather than Anthropic's
company wordmark or a Claude Code character: a simple silhouette is the better
16px candidate. This is a design preference, not a verified asset selection.
Neither spark nor character has a verified redistribution grant here. Ask for
light/dark artwork, minimum size, clear space, binary/source distribution rights
and the attribution text together. The guidelines give `marketing@anthropic.com`
as the contact for organizations with an existing business relationship.

## Codex — OpenAI

OpenAI's [Design Guidelines and Marks usage terms](https://openai.com/brand/)
cover third parties and provide conditional, revocable permission. Logos must
relate to OpenAI services, remain unmodified, acknowledge ownership, stay less
prominent than Foom, and imply no endorsement. The Blossom cannot receive added
colors; prescribed clear space applies. Co-branded partnership materials require
approval.

The public page offers logo downloads but does not specify a numeric minimum for
our 16px use. Its [full brand guide](https://brand.openai.com/) redirected to a
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
animate or add a glow. A 16px rendering is a proposed review size, not an approved
minimum. Get the minimum and spacing with approval.

Google's compatibility guidance also requires a legal attribution line in an
appropriate place in the product. Use its
[legal-line generator](https://partnermarketinghub.withgoogle.com/tools/legal-line-generator/)
or the exact wording supplied with approval; do not invent a registered-trademark
claim or treat attribution as permission.

## Shells and fallback

Draw a small, original chevron and underscore on a 16×16 SVG grid, or use the
literal `>_` in bundled Geist Mono. Do not trace an existing terminal application's
logo. The original SVG needs no third-party artwork notice; the font option uses
the existing font notices. No shell-specific artwork is selected or cleared by
this note: the shell's software license alone is insufficient evidence about a
separate logo. Use text such as `Shell (zsh)` for all four shells.

For a new agent, use a plain, non-stylized short label and its full name; use `?`
when the identity is unknown. These are Foom's UI abbreviations, not substitute
vendor trademarks or a finding that all name uses have permission. Do not turn
them into imitation logos or use them as Foom's marketing identity.

Use a 20px-high neutral badge slot with a 16px visual target; allow enough width
for two characters at a readable size instead of forcing them into a 16px square.
Use the existing badge fill/ink tokens. Keep the status light separate: no amber,
magenta, status tinting or animated identity mark. Include the full agent name in
the row's accessible name and a hover/focus label when it is otherwise absent.
Check both themes and 80–150% interface scaling in the implementation. If official
spacing cannot fit later, keep the text fallback rather than shrinking the mark.

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
Foom's Apache-2.0 claim. Suggested explanatory About copy is: “Agent names identify
the software running in each session. Foom is not affiliated with or endorsed by
Anthropic, OpenAI or Google.” This is Foom copy, not a vendor-mandated legal line.

## Follow-up

Implementation is tracked in
[#117](https://github.com/scott-r-lindsey/foom/issues/117): finalize the neutral
badges, original shell glyph and accessible labels after
the sidebar tree in [#113](https://github.com/scott-r-lindsey/foom/issues/113).
Official marks remain a separate asset-adoption decision with the conditions
above. About presentation coordinates with #96; missing permissions need not
block the neutral badges. No application or mockup changes belong in #112.
