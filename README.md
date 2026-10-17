# Foom

A desktop workspace for running coding agents in Git worktrees, with terminal tiles
and lights that route your attention. Built with Electron, strict TypeScript,
xterm.js and node-pty.

## Try a nightly

Download the latest tested build from the [rolling nightly prerelease](https://github.com/scott-r-lindsey/foom/releases/tag/nightly).
It contains macOS arm64, Linux x64 and Windows x64 ZIPs and `SHA256SUMS`.
Follow the [unsigned-build opening steps](docs/nightly-opening.md).

## Develop

Use Node.js 24 LTS (`nvm use`) and the pinned pnpm version through Corepack:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

Development launches use the persistent **Foom Dev** profile. Run everyday Foom
from a packaged build or a dedicated checkout no agent edits, and develop in a
separate worktree. See [contributor setup](AGENTS.md#building-foom-inside-foom).
Restart `pnpm start` after source edits; quit the existing Foom Dev app first.

The first launch opens **preflight**: welcome, agents, repositories, then go / no-go.
After setup, launch shells and agents from checkout panels, a shell from the home
row, or create a checkout with **New worktree** in a repository panel. Hidden
terminals keep running. **Settings** is in the Foom config gear panel and app menu.

Session restoration is on by default: eligible sessions that were running at quit
launch again, with agents resuming recorded conversations. Screens and scrollback
are not saved; dormant rows remain available for manual resume. See
[saved conversations](docs/architecture.md#saved-conversations) for eligibility and
[Settings](docs/product.md#settings) for the restore switch.

To try first run with a disposable profile:

```sh
pnpm run start:fresh        # deleted when Foom quits
pnpm run start:fresh --keep  # retain the profile to reopen later
```

Run `pnpm run check` before committing or pushing. For native prerequisites,
build details and command reference, see the [development guide](docs/development.md).
Required checks and delivery rules are in [AGENTS.md](AGENTS.md); CI and packaging
are explained in [validation](docs/validation.md).

## Documentation

Start with the [documentation map](docs/README.md). It identifies authoritative
product, architecture, contributor and protocol documents, recommended reading
paths, and material that is proposed design or historical research.

## License

Foom is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
project attribution. Third-party dependencies and bundled fonts retain their
respective licenses and notices.
