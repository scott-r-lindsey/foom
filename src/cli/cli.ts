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
        "foom [--json] whoami | sessions [--limit N] [--cursor ID] | session-state ID | operation-status --operation-id ID | operation-status --idempotency-key KEY\nHuman/script access: add --repository ABSOLUTE_PATH [--profile PROFILE]. Approve pairing in Foom.\nfoom pair --repository ABSOLUTE_PATH [--profile PROFILE] reads JSON argv arrays, one per line, for ten minutes.\nfoom --install-cli BIN_DIRECTORY | --uninstall-cli BIN_DIRECTORY (Windows: directory optional)\nfoom config validate PATH [--json] (offline, read-only)\nfoom --version | --help",
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
