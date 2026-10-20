/** One entry per command; alternate forms stay together in the same entry. */
const commandHelp = [
  {
    prefix: "foom [--json] ",
    commands: [
      "whoami",
      "sessions [--limit N] [--cursor ID]",
      "session-state ID",
      "operation-status --operation-id ID | operation-status --idempotency-key KEY",
    ],
    suffix: "",
  },
  {
    prefix: "Agents: ",
    commands: ["open-preview PATH", "previews", "close-preview PREVIEW_ID"],
    suffix: " (also with --json)",
  },
  {
    prefix: "Children only: ",
    commands: [
      "handoff --status done|blocked|failed --summary-file FILE|- [--link HTTPS_URL]... --idempotency-key KEY",
    ],
    suffix: "",
  },
  {
    prefix: "Orchestrators only: ",
    commands: [
      "read-handoff ID [--seq N]",
      "create-worktree BRANCH|--pull-request N --idempotency-key KEY",
      "launch WORKTREE_ID --agent claude|codex|agy [--prompt TEXT] --idempotency-key KEY",
      "prompt ID --text TEXT --idempotency-key KEY",
      "send-keys ID --keys y,enter --idempotency-key KEY",
      "stop ID --idempotency-key KEY",
      "close ID --idempotency-key KEY",
      "remove-worktree WORKTREE_ID --idempotency-key KEY",
      "tail ID [--lines 1-40]",
      "wait-for ID... [--after JSON_ID_TO_REVISION] [--timeout-ms 0-30000] | wait-for [ID...] --until-event [--after JSON_ID_TO_EVENT] [--timeout SECONDS]",
    ],
    suffix:
      "\nOrchestration mutations wait up to 60 seconds. Exit 6 (unknown_outcome) means the action may have succeeded. Check foom operation-status --idempotency-key KEY with the same credentials; never retry with a new key.\nConcurrent children and wait-for IDs follow Settings → General (default 4, range 1-16).\nHuman/script access: add --repository ABSOLUTE_PATH [--profile PROFILE]. Approve pairing in Foom.",
  },
  {
    prefix: "foom ",
    commands: [
      "pair --repository ABSOLUTE_PATH [--profile PROFILE] reads JSON argv arrays, one per line, for ten minutes.",
    ],
    suffix: "",
  },
  {
    prefix: "foom ",
    commands: ["--install-cli BIN_DIRECTORY", "--uninstall-cli BIN_DIRECTORY"],
    suffix: " (Windows: directory optional)",
  },
  {
    prefix: "Config sessions only: foom agent probe ",
    commands: [
      "start ID [--manifest PATH] [--resume CONVERSATION_ID]",
      "send PROBE TEXT",
      "keys PROBE esc|ctrl-c|enter|up|down|tab",
      "wait PROBE --quiet SECONDS|--timeout SECONDS",
      "screen PROBE [--save working|blocked|idle|other]",
      "state PROBE",
      "events PROBE",
      "stop PROBE",
    ],
    suffix: "",
  },
  {
    prefix: "foom ",
    commands: [
      "config status [--json] (config sessions only, read-only)",
      "config test-rules AGENT_ID [--json] (config sessions only, local screen rules)",
    ],
    suffix: "",
  },
  {
    prefix: "foom ",
    commands: ["config validate PATH [--json] (offline, read-only)"],
    suffix: "",
  },
  {
    prefix: "foom ",
    commands: ["--version", "--help"],
    suffix: "",
  },
];

export function help(): string {
  return commandHelp
    .map(({ prefix, commands, suffix }) => `${prefix}${commands.join(" | ")}${suffix}`)
    .join("\n");
}
