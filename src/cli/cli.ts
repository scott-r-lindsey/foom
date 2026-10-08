/** Stable console envelope. Config validation is reserved for the schemas in #84. */
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
      output: "foom --version | --help | --validate-config <path> [--json]",
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
