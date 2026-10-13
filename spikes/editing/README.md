# Text editing prototype

Throwaway prototype for [#223](https://github.com/scott-r-lindsey/foom/issues/223).
Read [the findings](../../docs/editing.md) first. It is not Foom code: it is
excluded from Foom's build, lint, format and coverage, and it changes nothing
under `src/`. Every run works in disposable `mkdtemp` fixture repositories and
profiles, which it deletes on exit. It never edits a real worktree or the
user's editor configuration.

| File | What it is |
|---|---|
| `model.cjs` | Worktree read/save with hash check and atomic rename, the profile scratch store, and editor launch argument arrays |
| `research.test.cjs` | Conflict, encoding, containment, scratch and launch tests; writes `results/conflicts.json` |
| `writer.cjs` | Uncooperative fixture writer forked by the two-agent workload |
| `build.mjs` | Bundles textarea, CodeMirror 6 and Monaco with the repo's esbuild; writes `results/bundles.json` |
| `main.cjs`, `runtime/` | Sandboxed Electron scratch pad with Foom's renderer CSP, one editor per run |
| `verify-ui.cjs` | Persistence, shortcut, Tab, axe, bridge and worker/CSP checks; writes `results/ui.json` and screenshots |
| `detect.cjs` | Linux editor detection on `PATH` and Flatpak; writes `results/detection.json` |
| `verify-handoff.cjs` | VS Code `--goto` with an isolated profile, and nvim in a PTY; writes `results/handoff.json` |

## Run

Use Node 24 and the repository's `npm ci`. The prototype borrows the repo's
Electron, esbuild, Playwright, axe and node-pty; its own dependencies install here:

```sh
npm ci --prefix spikes/editing
npm audit --prefix spikes/editing
node spikes/editing/build.mjs
node --test spikes/editing/research.test.cjs
node spikes/editing/detect.cjs
xvfb-run -a node spikes/editing/verify-ui.cjs
xvfb-run -a node spikes/editing/verify-handoff.cjs   # Linux, needs /usr/bin/code and /usr/bin/nvim
```

Electron runs only under a virtual display. `verify-handoff.cjs` starts VS Code
with a temporary `--user-data-dir` and `--extensions-dir` and disables extensions.
