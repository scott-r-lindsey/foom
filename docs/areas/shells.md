# Shells

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/attention.md).

### Shell lifecycle status

Explicit shell launches opt into invocation-scoped integration. Bash 4.4+ starts with
an isolated startup file that loads `/etc/profile` and the first readable user login
profile, then installs PS0 and prepends a status-preserving PROMPT_COMMAND callback
(the user's existing callbacks and PS0 are retained). This is an interactive shell;
Bash's `login_shell` option is not set. No user configuration files are modified.
The utility host removes the private startup directory on spawn failure or PTY exit.
Older Bash and other shells retain output, hook and process-exit detection.

The headless parser accepts OSC 633 lifecycle markers only with that launch's random
token. Terminal-ID-scoped, runtime-validated events report command start and prompt
return with a bounded exit status. Initial prompt means Ready (Quiet); a running
command means Working, and its next prompt means Done or Failed. Prompt editing,
empty commands and subsequent quiet evaluation preserve the last result. These are
status hints only, never capabilities or instructions. A permission hook and a real
process exit retain precedence. Lifecycle transitions, new output, user input and removal invalidate pending classification.
There is no Checking state. Ambiguous results say
“No completion or input request detected,” rather than implying a Quiet verdict.

### Foreground shell program names

For explicit shell launches, the terminal host reads node-pty’s foreground process name on Linux and macOS. Output triggers at most one lookup per second, coalescing throttled output into one trailing lookup so the final prompt clears names in shells without lifecycle markers; Bash lifecycle markers force a refresh and prompt completion clears the name. Because PS0 precedes the fork, command start also schedules one lookup after 100 ms for silent commands. Completion, removal and exit cancel it; no idle terminal is polled. The host suppresses the launched shell’s own name, rejects paths, whitespace and control characters, and bounds the name to 32 printable characters. Windows never queries ConPTY for this metadata. A validated ID-scoped host event reaches main only for live owned terminals, updates the existing workspace session snapshot, and passes through the board source as text. Session persistence omits the field.
