import opencode from "./bundled-agents/opencode.json";
import claude from "./bundled-agents/claude.json";
import codex from "./bundled-agents/codex.json";
import pi from "./bundled-agents/pi.json";
import agy from "./bundled-agents/agy.json";
import copilot from "./bundled-agents/copilot.json";

/** Build inputs only. This list conveys no runtime launch authority. */
export const bundledAgentData = [claude, codex, agy, copilot, opencode, pi];
