export class AgentManifestError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}
