import type { AgentId } from "./agents";
import type { BOARD_ACTIONS } from "./board-commands";

export type BoardCommand = (typeof BOARD_ACTIONS)[number] | `via-${AgentId}`;
