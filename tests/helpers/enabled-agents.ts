import { BUILTIN_AGENTS } from "../../src/shared/providers/catalog";

/** Explicit enablement for scenarios exercising the bundled fixture agents. */
export const ENABLED_AGENTS = Object.fromEntries(BUILTIN_AGENTS.map(({ id }) => [id, true]));
