# Preview tiles (research spike, #221)

Findings from the spike on previewing Markdown and HTML files in a tile, with live reload. The prototype lives in [`spikes/previews/`](../spikes/previews/README.md). It is throwaway code; nothing under `src/` changed. This document is research, not a decision. The follow-up tickets below decide each part. When one lands, that PR updates `architecture.md` and `product.md`.

**Recommendation:** show each preview in its own `WebContentsView`, in an in-memory session partition per preview, served from `foom-preview://<opaque id>/` by a handler confined to one worktree. The view has no preload, is sandboxed and allows no network by default. A main-process watcher reloads it when the files it actually loaded change. A sandboxed `<iframe>` in the board was the only real alternative. It composites better, but it needs a change to the board's CSP and shares the board's session, so it fails the issue's isolation rule.

## How this was measured

Electron 44.4.5 (Chromium 152) on Linux under Xvfb (1600×1000, software GL), using the repo's own Electron, esbuild, xterm and node-pty. Every scenario ran on its own, one after another, and its JSON output is committed in `spikes/previews/results/`. The board page uses Foom's exact CSP and a sandboxed preload. Main validates every board IPC sender and payload. A hostile page reports its probes through `executeJavaScript` from main; it has no bridge.

| Run | Command (from the repo root, with `xvfb-run -a -s "-screen 0 1600x1000x24"`) |
|---|---|
| Containment unit tests | `node --test spikes/previews/containment.test.cjs` (no display) |
| Hostile fixtures, recommended design | `npx electron spikes/previews/main.cjs verify --isolation=view` |
| Request filter alone (preview CSP removed) | `… verify --isolation=view --preview-csp=off` |
| Iframe alternative (board CSP plus `frame-src foom-preview:`) | `… verify --isolation=iframe` |
| Iframe with Foom's board CSP unchanged | `… verify --isolation=iframe --board-csp=foom` |
| Six previews: memory, resize, zoom | `… measure --isolation=view` and `--isolation=iframe` |

Not verified: Windows and macOS runs (junctions, `fs.watch` semantics, DPI), GPU compositing, and memory on those platforms. The Windows path rules are unit-tested on Linux. The junction test runs only on Windows.

## 1. Tile content model

Today a leaf is `{ kind: "tile", id, session: string | null }` (`src/renderer/board/tiles.d.ts`), saved as `foom.tiles.v1.<window-id>`.

- **Leaf shape.** Replace `session` with `content: null | { kind: "terminal"; session: string } | { kind: "preview"; preview: string }`. `terminals()`, `placeSession`, `swapTiles`, `dropTile` and `tidyTiles` keep working on "occupied" leaves; only terminal-specific paths (attachment, Hide, numbers in the sidebar) check `kind`.
- **Saved format.** Bump to `version: 2`. `restoreLayout` accepts version 1 and maps `session: s` to `content: { kind: "terminal", session: s }`. It writes only version 2. Preview IDs are validated like session IDs: bounded length, unique, and no capability by themselves.
- **Who owns a preview.** Main keeps a preview registry: `{ id, worktree, relativePath, network }`. The ID is the opaque origin host. It is persisted per window in main, not in localStorage, because it names a path. The renderer holds only IDs and the display facts main gives it. Opening a preview is an IPC command carrying a worktree path from the inventory and a relative path. Main validates both: the worktree must be in its inventory, and the path must resolve inside it (§3).
- **`pruneSessions` becomes `pruneContent(layout, { sessions, previews })`.** A preview whose ID main no longer reports becomes empty space, like a missing session. It runs only after the first inventory completes, as today.
- **Removed worktree or file.** When a worktree leaves the inventory, main closes its previews (watchers stopped, partition storage cleared) and the tiles become empty space. A removed *file* keeps its preview. The handler serves a Foom-generated "File not found. Waiting for it to appear." page with no scripts, and keeps watching the directory. The verify run deletes and recreates `page.html`; the preview recovers on its own (two reloads, 302 ms).
- **Sidebar.** Previews appear under their worktree as rows with a document glyph and no light: they have no attention state. A preview that isn't in a tile is not kept: closing its tile closes it. That avoids hidden previews accumulating watchers and renderer processes.
- **Numbering.** Today only terminals are numbered. Number previews too, in the same tree order, so "focus tile N" and the leader shortcuts reach every tile. This changes `product.md` ("Only terminals are numbered") and needs its own ticket.
- **Tile menu and facts.** Commands: Split right/down, Grow, Maximize/Restore, Reload, Allow network (§4), Close. There is no Hide: a preview has no process to keep running. Facts: path relative to the worktree, kind (Markdown or HTML), size, last reload, network off/on, and the number of watched files.

## 2. Isolation

| | `WebContentsView` per preview (recommended) | `<iframe sandbox>` in the board |
|---|---|---|
| Board CSP | Unchanged | Needs `frame-src foom-preview:`. With Foom's CSP unchanged, all three frames were refused ("Framing … violates the following Content Security Policy directive") and the handler served 0 requests |
| Origin | `foom-preview://<128-bit random id>` | Same, as a cross-origin child of `app://bundle` |
| Storage | In-memory partition per preview, gone on close; `localStorage` set by a hostile page read `null` from another preview | Shares the board's persistent session; origin-keyed, but stored in the profile and must be cleared per origin |
| Session policy | Own permission, download and `webRequest` handlers per preview | The board's handlers must tell board requests from preview requests |
| Preload / Node | None: `window.desktop`, `require`, `process`, `electron`, `ipcRenderer` all `undefined` | Same: the board preload runs only in the main frame |
| Embedder reach | `top === window`; nothing to reach | `parent.document` and `top.location` throw `SecurityError`, but `parent.postMessage` reaches the board, so the board must never listen for messages |
| Sandbox | `sandbox: true`, `contextIsolation`, no `nodeIntegration`, `disableDialogs`, `webviewTag: false` | `sandbox="allow-scripts allow-same-origin"` (safe only because the origin differs), `allow=""` |
| Composition | Views draw **above** the board's DOM: panels, the confirmation scrim and drag previews are hidden under them (`results/view-panel-covered.png`). The prototype hides views and shows a `capturePage` snapshot while board UI is on top (`results/view-panel.png`): 5–19 ms per view, 102 ms for six | Natural z-order (`results/iframe-panel.png`); needs `pointer-events: none` during drags |
| Maximize, drag | Board sends rectangles over validated IPC; main calls `setBounds`. Maximize/fade needs a snapshot during the animation | CSS, like terminals |
| Focus and shortcuts | A focused view swallows keys: the board's `before-input-event` saw nothing, so the shortcut handler must also be attached to each view (the prototype forwards Ctrl+Shift+B) | Board's `before-input-event` saw Ctrl+Shift+B natively |
| Zoom | Main must scale bounds by the board zoom and set the view's zoom; verified at 1.5× (CSS 301.8×152.4 → 453×229 DIP) | Inherited (`devicePixelRatio` 1.5) |
| Resize (30 window-width steps, six previews) | median 20 ms, p90 31 ms, max 36 ms until every preview reported its new width | median 21 ms, p90 36 ms, max 40 ms |
| Memory, six previews (3 Markdown docs, 3 mockups) | +691 MB working set over a 505 MB board-plus-terminal baseline (7 renderer processes, 752 MB) | +691 MB (7 renderer processes, 748 MB); site isolation already gives each origin a process |
| Hostile navigation | Page stays in place | An iframe navigating to an `http:` URL is refused by the board's `frame-src` and replaced by Chromium's error page ("frame gone"). The board survives, but the tile is blanked |

The iframe wins only on composition and shortcuts, and both have contained fixes in the view design. Memory and resize cost are the same. The deciding facts are the board CSP change and the shared session. Both are explicitly ruled out by the issue, and both widen what the board must defend.

Budget about 115 MB per open preview. Six previews roughly double Foom's footprint, so previews are opt-in and close with their tile.

## 3. File serving

`containment.cjs` resolves a request in this order:

1. **The URL parser first.** `foom-preview` is registered as a standard, secure scheme, so Chromium removes `..` and `%2e%2e` dot segments before the handler runs. `../../etc/hostname` arrives as `/etc/hostname` and resolves *inside* the worktree (404).
2. **Per-segment decoding.** Decode each segment and refuse empty, `.` and `..` segments, encoded `/` or `\`, NUL and control characters (400). Any segment that starts with `.` is refused: that covers `.git`, `.env` and editor state. It can be relaxed for a named allowlist if pages need it.
3. **Windows forms** (unit-tested on every platform): refuse `:` (drive letters, `::$DATA` streams), trailing dot or space, device names (`CON`, `nul.txt`, `COM1.md`) and `<>"|?*`. `\\?\` and UNC forms cannot be expressed, because `\` is refused.
4. **Real paths.** `realpath.native` the candidate and require it to equal, or sit under, the canonical root captured when the preview opened, compared byte for byte. Never case-fold: on a case-insensitive volume the worst outcome is a false refusal, never an escape. The `-evil` sibling-prefix case is tested.
5. **Recheck.** Re-check the real path's segments, so a symlink cannot land on a hidden name (`env-link.txt → .env` gives 403).
6. **Open safely.** Stat before opening (a FIFO is refused rather than blocking), open with `O_NOFOLLOW|O_NONBLOCK`, and require the descriptor's `dev`/`ino` to match. Read only from that descriptor.
7. **Limits.** 16 MiB per file and 2 MiB for Markdown (413). A directory serves its `index.html` or 404. Types come from a fixed extension map; anything else is `application/octet-stream` with `nosniff`.

Results: `node --test` passes 9 tests, and 1 skips (Windows junctions). In the live run, the hostile page got these:

| Request | Result |
|---|---|
| `../../../../etc/hostname`, `/%2e%2e/…/etc/hostname` | 404 (normalized to a path inside the worktree) |
| `/..%2f..%2f..%2fetc%2fhostname`, `/..%5c..%5cetc%5chostname` | 400 separator |
| `/escape-dir/secret.txt` (directory symlink out), `/escape-file.txt` | 403 escape |
| `/.env`, `/.git/config` | 400 hidden |
| `/big.bin` (17 MiB) | 413 |
| `/inside-link.md` (symlink inside) | 200 |
| `/hostile/secret-sibling.txt` | 200: **every non-hidden file in the worktree is readable by the page** |

Relative CSS, scripts and images load in both fixtures. The six-preview run used the repo's own `docs/mockups/*.html` and `docs/*.md` unchanged. Residual risk: swapping a *parent* directory for a symlink between `realpath` and `open` is not fully closed (only the final component is `O_NOFOLLOW`). The worst case is reading one file that the agent, which could swap directories, could already read. Network is off, so the page has nowhere to send it.

## 4. Network and navigation

**Default CSP for HTML** (a response header, which the page can only tighten):

```text
default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self';
worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none';
frame-ancestors 'none'
```

Scripts, including inline ones (every mockup uses them), run inside the isolated origin. `eval` stays off. Markdown gets a stricter policy: `script-src 'self'` for Foom's runtime only, and no inline script.

**Second layer:** each preview session's `webRequest` cancels everything except its own origin, `data:` and `blob:`. With the CSP removed (`--preview-csp=off`), the filter cancelled 13 requests on its own.

Across both runs, the local counting server saw **0 TCP connections**. The probes were `fetch` (cors and no-cors), `https://example.com`, `<img>`, stylesheet, `<script>`, `<iframe>`, WebSocket, `sendBeacon` (returns `true` but sends nothing), EventSource, dynamic `import()`, CSS `url()`, a blob Worker's `fetch`, and `<link rel=preconnect>`. `file:` fetches, images and frames all failed. Fetching another preview's origin failed with `TypeError`. Service-worker registration failed: the scheme does not grant it.

**What breaks without network:** our mockups request `fonts.googleapis.com` (recorded as a CSP violation) and fall back to system fonts. Layout and interaction still work (`results/view-six.png`).

**"Allow network" switch.** Per preview, off by default, shown as a tile fact, not persisted across restarts. When on, it adds `https:` (and `wss:` for connect) to the CSP and the filter. Plain `http:` stays blocked. Its real implication: a page that can read **every non-hidden file in the worktree** (§3) can now send them anywhere. The switch should therefore say "This page can send files from this worktree to the internet" and be a per-preview action, never a global setting. **Decision (#295):** keep the full, explicitly confirmed switch; do not precede it with a fonts-only allowlist. A font request can include file contents in its URL, so an allowlist would still create an exfiltration channel and need the same disclosure. It would also leave remote scripts, images and other assets broken. Network permission is runtime state only: registry writes always store `network: false`. Blocking network closes active connections and reloads the page with the default CSP.

**Navigation (the `nav.html` fixture, 11 attempts, recommended design).** The page stayed in place; the final URL was unchanged.

| Attempt | Outcome |
|---|---|
| `location = http://…`, `top.location = …`, meta refresh, link to `https:` | `will-frame-navigate` blocked (5 in all) |
| same-origin `.html` in the main frame | blocked; only same-origin `.md` may navigate in place |
| `window.open` (external and same-origin) | denied by `setWindowOpenHandler` (2) |
| `<a download>` | `will-download` prevented (1) |
| `location = file:///…`, `javascript:` URL, form POST | refused by Chromium or CSP (`form-action 'none'`) before the guard |
| Board after all attempts | URL unchanged (`spike-app://board/index.html`); one window |

**Permissions:** every request and check is denied: notifications `denied`, camera and clipboard read `NotAllowedError`, geolocation error. `alert()` returns immediately (`disableDialogs`).

**Links:** page script can request "open externally" without a click (meta refresh, scripted `location`, `window.open`), and `will-frame-navigate` offers no user-gesture check. So: always confirm, show the full URL, allow only `https:`/`http:`/`mailto:`, keep at most one confirmation open per preview, and drop requests made while one is pending. The prototype does this. In the navigation fixture, 2 confirmations opened and 3 requests were dropped while one was pending. Never open a link without confirming.

## 5. Markdown

Use **markdown-it 15** (`html: false`) plus **highlight.js 11** (the `common` language subset). Task lists come from a 20-line core rule (`runtime/markdown.mjs`); no plugin is needed. Rendering runs **inside the preview origin**: the handler wraps the `.md` source as JSON in a `<script type="application/json">` (with `<` escaped) and Foom's runtime renders it synchronously. Synchronous rendering lets scroll restoration see the final layout.

The hostile Markdown fixture produced:

- Raw `<script>`, `<img onerror>`, `<iframe>` and `<a onclick>` appear as text.
- No element has an `on*` attribute and no iframes exist.
- The only scripts are the JSON source and the runtime.
- `javascript:`, `vbscript:`, `data:` and `file:` links are not links: markdown-it's `validateLink` renders them as text.
- `window.__pwned` is unset.
- A remote image renders as an `<img>`, but the request is blocked (0 connections).
- `[other](../demo/other.md)` navigated in the same tile ("Other page").

Relative images and links resolve against the page URL inside the origin. External links get a marker and go through the confirm described above.

**Mermaid:** v12.1.0 is 5.5 MB minified (1.57 MB gzip) with 23 direct dependencies. That is 20× the whole Markdown runtime. Its history of `securityLevel` XSS issues would be contained by the isolated origin. Not worth it for the first version: show ```` ```mermaid ```` blocks as code. If it is wanted later, load it lazily in the preview origin only when a document contains such a block.

## 6. Live reload

The main process watches **only what the page loaded.** The protocol handler records each file it served, and each missing file inside the worktree. The preview watches those files' parent directories with `fs.watch` (non-recursive), filtered by file name. Directory watches survive atomic rename-over saves and deletions. This is the same pattern as the Git inventory watcher. There is no new dependency: chokidar and @parcel/watcher solve recursive watching, which this design does not need. Each preview is capped at 64 directories.

Debounce: 120 ms trailing with a 1 s maximum wait, so a long burst cannot starve the preview. Before reloading, main reads `[scrollX, scrollY]` in an isolated world (the page cannot spoof it), validates it, and restores it after `did-finish-load`.

The handler also watches the name the page requested when it differs from the resolved target. Replacing or retargeting a symlink changes that directory entry, not the old target.

| Change | Write to visible reload | Reloads |
|---|---|---|
| Direct write to `page.html` | 153 ms | 1 |
| Atomic rename (write `.tmp`, rename over) | 254 ms | 1 |
| 20 writes at 10 ms intervals | 369 ms | 1 |
| `style.css` only | 175 ms | 1 |
| Delete, then recreate 300 ms later | 303 ms | 2 (404 page, then the page) |
| Symlink `inside-link.md` atomically replaced by a regular file | 175 ms | 1 |
| Scroll position kept | 1200 px restored | |

These are single runs, measured by polling the page every 100 ms. Across repeated runs and the iframe mode, individual values varied by up to 100 ms. Closing a preview closed its watcher (1 → 0) and cleared its storage. With six previews, watching costs one directory handle per distinct asset directory, typically 1–3 per page. Windows and macOS still need the same scenarios run; on Windows, a deleted watched directory raises an error, which the prototype handles by dropping the watch and reloading once.

## 7. Theme

`prefers-color-scheme` in both preview kinds follows `nativeTheme.themeSource`, which Foom already sets from its Appearance setting. Verified: switching to dark and back gave `true`/`false` in HTML, and Markdown backgrounds `rgb(5, 4, 10)` / `rgb(243, 240, 250)`. The Markdown stylesheet copies Foom's light and dark tokens; the preview origin cannot load board CSS. Custom themes (#205) are not conveyed. A follow-up could pass the active token values as a generated stylesheet at `/__foom__/theme.css`. HTML pages follow light/dark only if they use `prefers-color-scheme` or `color-scheme`.

## 8. Packaging

Two production dependencies: `markdown-it` (6 transitive packages) and `highlight.js`. The bundled runtime is 264 KB minified (97 KB gzip) as one asset served only to previews. That is 13 MB in `node_modules`, mostly highlight.js sources, which the bundle tree-shakes. `npm audit` in `spikes/previews`: 0 vulnerabilities. Mermaid would add 1.6 MB gzip.

## Recommended design

1. Main owns a preview registry keyed by an opaque random ID. Each preview gets a `WebContentsView` in an in-memory `preview-<id>` partition with no preload. Settings: `sandbox`, `contextIsolation`, no `nodeIntegration`, `disableDialogs`, `navigateOnDragDrop: false`, `webviewTag: false`, no devtools in packaged builds.
2. A per-session `foom-preview` handler confined to one canonical worktree root (§3). It sets CSP, `nosniff`, `no-store` and `no-referrer` headers.
3. Per-session policy: deny all permissions, devices and display media. Prevent downloads. Filter requests to the preview's own origin, plus `https:` only when the user allows network.
4. Navigation guard: same-origin `.md` in place. Everything else is blocked; `http(s)`/`mailto` get a confirmed external open.
5. The board reports tile rectangles through a validated IPC message carrying preview IDs. Main applies board zoom and visibility. Board overlays (panels, confirmation scrim, drag, maximize animation) swap views for snapshots.
6. Attach the board's shortcut handler to every preview's `before-input-event`.
7. Markdown renders in the preview origin with markdown-it and highlight.js. A watcher on the loaded files triggers a debounced reload with scroll restore.

## Follow-up implementation tickets

1. **Tile content kinds and layout v2:** `content` union, v1 → v2 migration, `pruneContent`, numbering for every occupied tile, and the sidebar preview rows. Updates `product.md` and `architecture.md`.
2. **Preview host in main:** registry, `WebContentsView` lifecycle, per-preview partition and session policy, the IPC contract for open/close/bounds/overlay with validation, and Electron tests with the hostile fixtures ported from `spikes/previews/fixtures/`.
3. **Contained file protocol:** port `containment.cjs` to TypeScript under `src/main/previews/` with unit tests (including Windows junctions on the Windows CI job) and the CSP/header policy.
4. **Composition with board overlays:** snapshot swap for row/tile panels, the confirmation scrim, drag previews and maximize; shortcut forwarding.
5. **Markdown renderer:** markdown-it + highlight.js bundle served at a reserved path, task lists, token-based light/dark stylesheet, and in-tile `.md` navigation. Dependency review and `npm run audit`.
6. **Live reload:** served-file watcher, debounce, scroll restore, and missing-file recovery; Electron tests on all three platforms.
7. **External links and Allow network:** the confirm flow with one prompt at a time, plus the per-preview network switch and its disclosure. Decide whether a fonts-only allowlist replaces it.
8. **Opening previews:** worktree panel and file picker commands (paths chosen in main), and closing previews when a worktree is removed.
9. **Later, optional:** custom-theme tokens for Markdown (#205) and lazily loaded Mermaid.
