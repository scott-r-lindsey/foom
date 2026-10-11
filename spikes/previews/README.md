# Preview tiles prototype

Throwaway prototype for [#221](https://github.com/scott-r-lindsey/foom/issues/221).
Read [the findings](../../docs/previews.md) first. It is not Foom code: it is
excluded from Foom's build, lint, format and coverage, and it changes nothing
under `src/`. It writes only to a temporary directory, which it deletes on exit.

## Run

Use Node 24 and the repository's `npm ci`. The prototype borrows the repo's
Electron, esbuild, xterm and node-pty; its own two dependencies install here:

```sh
npm ci --prefix spikes/previews
npm audit --prefix spikes/previews
node --test spikes/previews/containment.test.cjs
```

Interactive demo (opens a window): a terminal beside a Markdown and an HTML
preview of a temporary copy of `fixtures/demo/`. Edit the files from the
terminal and watch them reload.

```sh
npx electron spikes/previews/main.cjs demo
npx electron spikes/previews/main.cjs demo --root=. --md=docs/previews.md --html=docs/mockups/tiles.html
npx electron spikes/previews/main.cjs demo --isolation=iframe
```

Evidence runs, sequentially, under a virtual display (no window on your desktop).
Each writes JSON (and screenshots) to `results/`:

```sh
X='xvfb-run -a -s "-screen 0 1600x1000x24"'
R=spikes/previews/results
eval $X npx electron spikes/previews/main.cjs verify --isolation=view --out=$R/verify-view.json
eval $X npx electron spikes/previews/main.cjs verify --isolation=view --preview-csp=off --out=$R/verify-view-nocsp.json
eval $X npx electron spikes/previews/main.cjs verify --isolation=iframe --out=$R/verify-iframe.json
eval $X npx electron spikes/previews/main.cjs verify --isolation=iframe --board-csp=foom --out=$R/verify-iframe-foomcsp.json
eval $X npx electron spikes/previews/main.cjs measure --isolation=view --out=$R/measure-view.json
eval $X npx electron spikes/previews/main.cjs measure --isolation=iframe --out=$R/measure-iframe.json
```

`verify` builds a temporary worktree from `fixtures/`, plus `.env`, `.git/`, an
outside secret, escaping and inside symlinks and an oversized file. It starts a
local HTTP server that counts every TCP connection, then loads the hostile HTML
and Markdown fixtures, the navigation fixture, shortcut, theme and live-reload
scenarios. `measure` opens six previews of this repository's docs and mockups.
A 110-second watchdog ends a stuck run with exit code 2.

## Files

| File | Role |
|---|---|
| `main.cjs` | Electron main: board window, preview views or iframes, protocol handler, session policy, navigation guard, watchers, harness |
| `containment.cjs`, `containment.test.cjs` | Path containment policy and its `node:test` tests |
| `build.cjs` | Bundles `runtime/board.mjs` and `runtime/markdown.mjs` into `.build/` and prints their sizes |
| `runtime/` | Board page (Foom's CSP), its sandboxed preload, and the in-preview Markdown runtime and stylesheet |
| `fixtures/demo/`, `fixtures/hostile/` | Friendly and hostile pages; `PORT` is replaced with the counting server's port |
| `results/` | The committed runs cited in `docs/previews.md` |
