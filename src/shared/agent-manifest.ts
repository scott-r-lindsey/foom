export class AgentManifestError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    readonly detail?: string,
  ) {
    super(`${path}: ${reason}${detail ? `: ${detail}` : ""}`);
  }
}
