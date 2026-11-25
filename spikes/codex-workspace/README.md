# Codex Workspace sandbox spike (#1078)

Measured on Linux Mint 22.1, kernel 6.8.0-147-generic, x86-64, with
`codex-cli 0.167.0`, Node 24.22.3, and pnpm 10.34.7.

## Method

Every Codex invocation used a new `mktemp -d` directory as `CODEX_HOME`. The
runner issued no model requests and ran with no interactive terminal. The
version and help commands (`codex --version`, `codex --help`, and
`codex sandbox --help`) each exited 0. They warned that helper aliases cannot
be created under `/tmp`. The sandbox commands could still start.

The table abbreviates the exact argument sequences below. Substitute the
absolute paths returned by the two Git commands for the path placeholders.
The URL placeholders designate the public GitHub repository HTTPS clone URL
and the GitHub REST API `/rate_limit` URL.
Workspace probes ran from the linked worktree. The commit probe ran from a
scratch clone under `/tmp`, created with
`git clone --no-local -- "<worktree>" "<scratch-clone>"`. Its installed
dependencies and generated Husky launchers were copied from the worktree and
its local `core.hooksPath` was set to `.husky/_`. In this clone the common
Git directory and the per-checkout Git directory are the same path.

| Name | Arguments or command |
| --- | --- |
| Workspace | `-c 'sandbox_mode="workspace-write"'` |
| Network | `-c 'sandbox_workspace_write.network_access=true'` |
| Shared | `-c 'sandbox_workspace_write.writable_roots=["<shared-git-dir>"]'` |
| Scratch Git | `-c 'sandbox_workspace_write.writable_roots=["<scratch-clone>/.git"]'` |
| Both | `-c 'sandbox_workspace_write.writable_roots=["<shared-git-dir>","<worktree-git-dir>"]'` |
| Shared Git path | `git rev-parse --path-format=absolute --git-common-dir` |
| Worktree Git path | `git rev-parse --absolute-git-dir` |
| Write | `python3 -c 'import tempfile; tempfile.TemporaryFile(dir=".").close()'` |
| HTTPS | `curl -fsS --max-time 15 -o /dev/null "<github-rate-limit-url>"` |
| Local fetch | `git fetch --no-tags . HEAD` |
| Remote fetch | `git -c credential.helper= fetch --no-tags "<repository-https-url>" HEAD` |
| API auth | `gh api rate_limit` (output suppressed) |
| Install | `pnpm install --frozen-lockfile` |
| Check | `pnpm run check` |
| Electron | `xvfb-run -a pnpm run test:electron '--test-name-pattern=a fresh profile opens preflight, and it passes accessibility checks'` |
| Scratch commit | `git -c user.name=<name> -c user.email=<email> commit --allow-empty -m 'Workspace sandbox spike'` |

Runner syntax was `codex sandbox [arguments] -- [command]`. Direct comparisons
used the same command without that prefix. The Git probes disabled system and
global Git configuration and terminal credential prompts. The remote fetch
used HTTPS and wrote `FETCH_HEAD` without updating branch refs. The validation
commands used temporary home and XDG directories. The GitHub auth probe used the
existing GitHub CLI auth context and kept its response private.

## Results

| Probe | Runner arguments | Exit and observation | Direct comparison on failure |
| --- | --- | --- | --- |
| Write | Workspace | 0 | |
| HTTPS | Workspace | 6, DNS resolution failed | 0 |
| HTTPS | Workspace + Network | 0 | |
| Local fetch | Workspace + Network | 255, worktree `FETCH_HEAD` was read-only | 0 |
| Local fetch | Workspace + Network + Shared | 255, worktree `FETCH_HEAD` was read-only | 0 |
| Remote fetch | Workspace + Network + Shared | 255, worktree `FETCH_HEAD` was read-only | 0 |
| Local fetch | Workspace + Network + Both | 0 | |
| Local fetch | `codex --add-dir "<shared-git-dir>" sandbox` with Workspace + Network | 255, worktree `FETCH_HEAD` was read-only | 0, same Local fetch comparison above |
| `test -w "<shared-git-dir>"` | Workspace + Network + Shared | 0, writable | |
| `test -w "<worktree-git-dir>"` | Workspace + Network + Shared | 1, read-only | 0 |
| Remote fetch | Workspace + Network + Both | 0 | |
| API auth | Workspace + Network + Both | 0, auth worked | |
| Install | Workspace + Network + Both | 0, dependencies installed and Husky prepared | |
| Check | Workspace + Network + Both | 1, 58 remote-management unit failures including `unsafe-folder` and missing fixture files | 0, full check passed |
| Scratch commit | Workspace + Network + Scratch Git | 1, Husky stopped the commit after the same 58 unit failures | 0, hook passed and scratch commit created |
| Electron, initial toolchain | Workspace + Network + Both | 1, Node runtime `LICENSE` missing at the build script's expected path | 1, same missing file |
| Electron, corrected toolchain | Workspace + Network + Both | 0, selected preflight test passed with Chromium sandboxing enabled | |
| `stat -c '%a %u %n' / /tmp` | Workspace + Network + Both | 0, owner UID 65534 for both paths | 0, owner UID 0 for both paths |
| Precedence control, Write | Config only | 1, read-only filesystem | 0 |
| Precedence control, HTTPS | Config only | 6, DNS resolution failed | 0 |
| Precedence, Write | Workspace + Network + Shared | 0 | |
| Precedence, HTTPS | Workspace + Network + Shared | 0 | |
| Precedence, Local fetch | Workspace + Network + Shared | 255, worktree `FETCH_HEAD` was read-only | 0 |
| Precedence, Local fetch | Workspace + Network + Both | 0 | |

The precedence rows used this temporary configuration.

```toml
sandbox_mode = "read-only"

[sandbox_workspace_write]
network_access = false
writable_roots = []
```

The per-launch arguments overrode this file for workspace writes, network access,
and writable roots. Adding the shared Git directory alone left the linked
worktree's Git metadata read-only. Explicitly adding the per-worktree Git
directory as a second root made the same fetch succeed.

Under the sandbox, `/tmp` retained mode 1777 but changed from owner UID 0 to
65534 as seen by the test process. Foom's folder validation allows a
group- or world-writable ancestor only when it is sticky and owned by UID 0.
The observed owner therefore explains the fixture's `unsafe-folder` rejection.

The initial Electron failure reproduced outside Codex. The temporary Node
installation came from the `node` npm package. Its platform package provided
the license, so the retry exposed that file at the runtime path expected by
the build script. The Electron command and repository code stayed the same.

## What remains unproven

The direct runner did not exercise the interactive agent's approval flow,
including whether `--ask-for-approval never` takes effect in a Foom launch and
how a denied operation is surfaced. The precedence probe covers only the
temporary file and overrides shown above. The user's actual configuration,
project configuration conflicts, and enterprise-managed policy were outside
the experiment. The results apply to this Codex version on one Linux machine.
Other Linux setups, macOS, Windows, other agents, and broader Git operations
such as pushing from the sandbox remain unmeasured.

## Recommendation

**Workspace does not support the full Foom workflow on this machine.**
Network access and both Git roots enabled fetch, dependency installation,
and GitHub authentication. The focused Electron test also passed with
Chromium sandboxing enabled. The same Codex sandbox still failed the
required `pnpm run check` and the pre-commit hook. Both passed directly.
Workspace is therefore unsuitable as the default for unattended Foom
development on this setup.
