# Control Policy

## Decision

One main-process control service owns authorization and operations. A Streamable
HTTP MCP server and the `foom` console CLI are thin adapters to it. Attach MCP per
launch to supported agents. Antigravity uses the explicitly disclosed, opt-in
Foom lifecycle plugin for environment-only MCP; absent, old, disabled or damaged
plugins retain the CLI fallback. This plugin is the sole global installation
exception; never install other agent configuration, plugins or skills globally
or into a repository. See [attachment rules](mcp-attachment.md#antigravity). MCP server
instructions and tool descriptions explain the workflow and limits.

Only the human grants orchestration, from a running agent session's menu: **Make
orchestrator…** (a trusted confirmation) and **Revoke orchestrator** (#303). There
is no orchestrator launch; any Foom-launched agent session can be elevated,
including one running with bypass permissions. Main permits one active orchestrator
per canonical repository, with a configurable limit of
running children (Settings → General → Concurrent children per orchestrator; default
4, integer 1–16), each in a new worktree in that repository. Children get ordinary
scoped credentials for metadata, previews and reporting to their parent; they cannot create grandchildren through Foom. Agent-native
subagents and processes outside Foom are not controlled by this limit.

Per-agent default launch arguments (#164) apply to user launches and to orchestrator
children (#155, #535). Children must never run with bypass defaults: a launch whose
defaults bypass permissions is refused rather than silently stripped, unless a future
design explicitly allows it with its own authorization rules. A user's acknowledgement for manual
launches does not authorize an orchestrator to grant bypass to children.

**Child input decision (#629):** a granted orchestrator can prompt and send logical
keys to its own non-taken-over children in its repository without per-message
human approval, including permission, credential and provider prompts. This
replaces the question-only reviewed reply gate; no atomic, question-specific input
channel is required. Same-user processes are not isolated by Foom capabilities.

Enforced read-only review ([#114](https://github.com/scott-r-lindsey/foom/issues/114)) and remote mirrored access ([#67](https://github.com/scott-r-lindsey/foom/issues/67)) remain separate capabilities; an ordinary review child in a fresh worktree does not imply either grant.
