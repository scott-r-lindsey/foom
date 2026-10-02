# Bundled fonts

## Interface fonts

Unmodified TrueType fonts from [Google Fonts](https://github.com/google/fonts/tree/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl), revision `23e54b51ddffbc7713c583748e3bd86f62b1fa4a`. Each family includes its SIL Open Font License. Archivo Black and Courier Prime are regular faces; Geist and Geist Mono are variable weight faces (100–900). All files ship locally; no network font requests are used.

## Terminal: Hack Nerd Font Mono

Regular and Bold from the official [Nerd Fonts v3.5.1 release](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1), built on **Hack 3.003**. This was the current release when imported. Download: [Hack.tar.xz](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/Hack.tar.xz). The archive SHA-256 matches GitHub's release-asset digest:

`cdd389472e10e2261520140ff1b382b4f8a226af5fd0b2735b975d31151d9c3c`

Only the **Mono** variant is shipped. No fonts are copied from a developer's installed fonts. The full fonts are converted to WOFF2 without subsetting, changing their names, or editing glyphs; character maps, names and advance widths are preserved. Builds copy the committed files and require neither network access nor font-conversion tools.

| File | Bytes | SHA-256 |
|---|---:|---|
| Upstream `HackNerdFontMono-Regular.ttf` | 2,778,948 | `e5aeb58577a8acf2b42083e4a07ce48bd53116fdd868636403cadb5b547351be` |
| Upstream `HackNerdFontMono-Bold.ttf` | 2,787,176 | `7c2c76c26ff80fb546798b204ae519335573417c969eb3142d202298722d3832` |
| Bundled `HackNerdFontMono-Regular.woff2` | 1,251,720 | `07f89c877a0c8570516a2c1b8f153d7721eaf7459a9de4025450ff7c63d300b0` |
| Bundled `HackNerdFontMono-Bold.woff2` | 1,252,952 | `ec87d7b5b515b4af56e79dacf6a8c8dee6ec7e5bf4046f812193f776b245ea50` |

Conversion used fontTools 4.46.0 with Brotli (Python, outside the app's dependencies):

```python
from fontTools.ttLib import TTFont
for weight in ("Regular", "Bold"):
    font = TTFont(f"HackNerdFontMono-{weight}.ttf", recalcTimestamp=False)
    font.flavor = "woff2"
    font.save(f"HackNerdFontMono-{weight}.woff2")
```

The two TTFs total **5,566,124 bytes**; the WOFF2s total **2,504,672 bytes**, a **55.0% reduction** before ZIP compression.

### Selection and italics

Terminal output and the Settings preview use `"Hack Nerd Font Mono", "Geist Mono", monospace`. Interface monospace remains Geist Mono. Regular and Bold use bundled URLs even if a local version is installed. Both weights load before the first terminal attachment or launch measures its grid.

No italic files are bundled. Italic terminal cells first try a separate CSS family with local full-name and PostScript-name sources (`Hack Nerd Font Mono Italic` / `HackNFM-Italic`, and `Hack Nerd Font Mono Bold Italic` / `HackNFM-BoldItalic`). If unavailable, that family falls through to bundled Hack, allowing Chromium to synthesize italics. Keeping local-only italics separate avoids a failed italic face in the bundled family forcing a fallback to Geist Mono.

### Licenses and attributions

- `hack-LICENSE.txt`: verbatim release-archive license, including Source Foundry's MIT license, DejaVu's public-domain notice, and the Bitstream Vera license (reserved names **Bitstream** and **Vera**).
- `nerd-fonts-LICENSE.txt`: Nerd Fonts' versioned top-level license.
- `nerd-fonts-glyphs-NOTICES.txt`: versioned glyph-set inventory, authors/source links, and license texts. Includes **Microsoft Codicons, CC BY 4.0**, its attribution and transformation notice. Font Logos retains the upstream inventory's classification; these logo glyphs are available to terminal programs and are not used in Foom's own UI.

The build copies the licenses beside the font files and collects all bundled font license texts into `build/THIRD_PARTY_NOTICES.txt`, referenced by the packaged root `NOTICE`. The packaged smoke test verifies these texts and the font binaries against the sources, and checks font rendering under `font-src 'self'` on Linux, macOS and Windows. Local matching is disabled for the rendering probe so installed fonts cannot mask a missing asset; both ASCII and U+E0B0 must render from the bundled face at one-cell advance width, including synthetic italic styles.
