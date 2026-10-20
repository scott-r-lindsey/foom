# Overview

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

## Terms

- **Repository**: a git repo the user has added.
- **Worktree**: a `git worktree` for one branch, created by Foom or another tool. Every checkout can run multiple shells and agents. Shells need no sharing confirmation. Starting an agent while another agent is still running in that checkout requires confirmation because they can edit the same files. Exited agents do not trigger the warning.
- **Terminal**: one PTY session inside a worktree. It may run an agent, a dev server, or a shell.
- **Light**: the indicator that represents a hidden terminal.
- **Evaluator**: the local rules pipeline that decides what a terminal's state is when its output stops.

## Mockups

Clickable mockups live in [`docs/mockups/`](../mockups/README.md): the [board](../mockups/board.html), [first run](../mockups/first-run.html), and [brand](../mockups/brand.html). The board and first-run mockups predate the brand; take their layout and behavior, and take color and type from [brand.md](../brand.md). The mockups README lists what else they get wrong.
