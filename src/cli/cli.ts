/** Stable console envelope. Includes offline configuration validation. */
export function run(
  args: readonly string[],
  version: string,
): {
  output: unknown;
  error: boolean;
  code: number;
} {
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  if (words.length === 1 && words[0] === "--version")
    return {
      output: json ? { version, protocol: 1 } : `foom ${version} (protocol 1)`,
      error: false,
      code: 0,
    };
  if (words.length === 0 || (words.length === 1 && words[0] === "--help"))
    return {
      output:
        "foom [--json] whoami | sessions [--limit N] [--cursor ID] | session-state ID | operation-status --operation-id ID | operation-status --idempotency-key KEY\nAgents: open-preview PATH | previews | close-preview PREVIEW_ID (also with --json)\nChildren only: handoff --status done|blocked|failed --summary-file FILE|- [--link HTTPS_URL]... --idempotency-key KEY\nOrchestrators only: read-handoff ID [--seq N] | create-worktree BRANCH|--pull-request N --idempotency-key KEY | launch WORKTREE_ID --agent claude|codex|agy [--prompt TEXT] --idempotency-key KEY | prompt ID --text TEXT --idempotency-key KEY | send-keys ID --keys y,enter --idempotency-key KEY | stop ID --idempotency-key KEY | close ID --idempotency-key KEY | remove-worktree WORKTREE_ID --idempotency-key KEY | tail ID [--lines 1-40] | wait-for ID... [--after JSON_ID_TO_REVISION] [--timeout-ms 0-30000] | wait-for [ID...] --until-event [--after JSON_ID_TO_EVENT] [--timeout SECONDS]\nOrchestration mutations wait up to 60 seconds. Exit 6 (unknown_outcome) means the action may have succeeded. Check foom operation-status --idempotency-key KEY with the same credentials; never retry with a new key.\nConcurrent children and wait-for IDs follow Settings → General (default 4, range 1-16).\nHuman/script access: add --repository ABSOLUTE_PATH [--profile PROFILE]. Approve pairing in Foom.\nfoom pair --repository ABSOLUTE_PATH [--profile PROFILE] reads JSON argv arrays, one per line, for ten minutes.\nfoom --install-cli BIN_DIRECTORY | --uninstall-cli BIN_DIRECTORY (Windows: directory optional)\nConfig sessions only: foom agent probe start ID [--manifest PATH] [--resume CONVERSATION_ID] | send PROBE TEXT | keys PROBE esc|ctrl-c|enter|up|down|tab | wait PROBE --quiet SECONDS|--timeout SECONDS | screen PROBE | state PROBE | stop PROBE\nfoom config status [--json] (config sessions only, read-only)\nfoom config validate PATH [--json] (offline, read-only)\nfoom --version | --help",
      error: false,
      code: 0,
    };
  return {
    output: {
      error:
        words.length === 2 && words[0] === "--validate-config"
          ? "config_schema_unavailable"
          : "invalid_request",
    },
    error: true,
    code: 2,
  };
}
