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

## Follow-up with a private TMPDIR

The follow-up set `TMPDIR` on the command with
`env TMPDIR="<private-tmp>" <command>`. It used the same absolute directory
for each sandboxed command and its direct control. The directory was created
with `mktemp -d "<worktree>/t.XXXXXX"` and removed afterward.
`stat -c '%a %u' "<private-tmp>"` exited 0 inside and outside the sandbox.
It reported mode 700 and the invoking user's UID in both cases. The scratch
commit runner added `"<private-tmp>"` alongside `"<scratch-clone>/.git"`
in `sandbox_workspace_write.writable_roots` because the commit ran from the
clone. The follow-up commits used the Scratch commit arguments with
`-m 'Workspace sandbox spike: private TMPDIR'`.

| Probe | TMPDIR | Workspace exit | Direct exit |
| --- | --- | --- | --- |
| Check | In worktree | 1, 135 unit failures | 1, 130 unit failures |
| Scratch commit | In worktree | 1, Husky stopped on the same 135 unit failures | 1, Husky stopped on the same 130 unit failures |
| Check | Shorter path under `/tmp` | 1, the original 58 ownership-related failures | 0, full check passed |
| Scratch commit | Shorter path under `/tmp` | 1, Husky stopped on the same 58 unit failures | 0, hook passed and scratch commit created |

The in-worktree path eliminated all 53 original failures in
`management.test.ts`. That suite uses `os.tmpdir()`. The five original
failures in `management-connection.test.ts` remained in Workspace. It
creates its fixtures directly below `/tmp`, independent of `TMPDIR`.
The fixture operations use the same ownership check that rejects the
sandbox's view of `/tmp`.

| Remaining case in `management-connection.test.ts` | Error |
| --- | --- |
| daemon + management + fixture Git survives the old 10s deadline and publishes one checkout | `ENOENT` for `started` |
| disconnect cancels fixture Git, removes staging, and permits a reconciled retry | `ENOENT` for `started` |
| expiry cancels fixture Git, removes staging, and permits a reconciled retry | `ENOENT` for `started` |
| shutdown cancels fixture Git, removes staging, and permits a reconciled retry | `ENOENT` for `started` |
| cumulative inventory may exceed 10s while each fixed fixture probe stays within 5s | `ENOENT` for `counter` |

The in-worktree `TMPDIR` was 80 bytes. With the test runner's
temporary subdirectory and the remote daemon's socket suffix, the socket
path was 125 bytes, above Foom's 100-byte limit. Foom reported
`Host socket path too long` or `Remote socket path too long` in its
preflight checks. The legacy fixture reported `listen EINVAL`. SSH
host-key tests reported timeouts and prompt assertions after hitting the
askpass socket path limit. These 130 failures reproduced directly with
the same directory.

| Additional failing unit suite | Failed cases |
| --- | ---: |
| `terminal-host/remote/daemon.test.ts` | 86 |
| `terminal-host/remote/agent-launch.test.ts` | 15 |
| `main/setup/ssh-host-key.test.ts` | 11 |
| `terminal-host/remote/legacy.test.ts` | 9 |
| `terminal-host/remote/agent-endpoint.test.ts` | 5 |
| `terminal-host/remote/shell-privacy.test.ts` | 3 |
| `terminal-host/remote/private-path.test.ts` | 1 |

The retry used `mktemp -d /tmp/t.XXXXXX` for a shorter, user-owned directory
with mode 700. The directory was 13 bytes long in its absolute form. Each
sandbox launch explicitly added that directory to its writable roots. Check
used `["<shared-git-dir>","<worktree-git-dir>","<short-tmp>"]` and the scratch
commit used `["<scratch-clone>/.git","<short-tmp>"]`. Each direct control
used the same shorter directory. The socket failures cleared. The shorter
directory still had `/tmp` as an ancestor, so Workspace again failed all
53 ownership-related cases in `management.test.ts` and the same five cases in
`management-connection.test.ts`.

## Git metadata writability

These probes ran only in the scratch clone. The `test -w` probes queried
access permissions.

| Command | Workspace + Network | Workspace + Network + Scratch Git | Direct |
| --- | --- | --- | --- |
| `test -w .git/hooks` | 1, read-only | 0, writable | 0 |
| `test -w .git/config` | 1, read-only | 0, writable | 0 |

With Scratch Git granted, this command exited 0. It created an empty file
under the scratch clone's hooks directory, verified it existed, and removed
it before any hooked commit.

```sh
sh -c 'set -eu; set -C; : > .git/hooks/workspace-spike-probe; test -f .git/hooks/workspace-spike-probe; rm -- .git/hooks/workspace-spike-probe'
```

Codex 0.167.0's sandbox did not retain write protection for these paths
after the explicit Git root grant. A sandboxed agent with that grant could
change hooks or Git configuration, and a later unsandboxed Git command
could then execute code selected by those changes. The experiment measured
write access and an empty file's creation and removal. Execution through
modified hooks or config remains unmeasured.

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
Keep Workspace out of the unattended default on this setup. Neither tested
`TMPDIR` passed the required check and pre-commit hook in Workspace. A
future approach also needs to account for the effects of granting write
access to Git metadata used by later unsandboxed commands.
