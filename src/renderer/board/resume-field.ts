import { builtinAgent } from "../../shared/providers/catalog";
import type { AgentId } from "../../shared/agents";
import { conversationId } from "../../shared/conversation";

/** Deliberately not a shell parser: only the CLI's literal resume forms are accepted. */
export function parseResume(text: string): { id: string; agent?: AgentId } | undefined {
  const trimmed = text.trim();
  if (conversationId(text.trim())) return { id: trimmed };
  if (/[\r\n]/u.test(trimmed)) return;
  const parts = trimmed.split(/[ \t]+/u);
  const [command, option, id] = parts;
  if (parts.length !== 3 || !conversationId(id)) return;
  const agent = ["claude", "codex", "agy"]
    .map(builtinAgent)
    .find(
      (entry) =>
        entry !== undefined &&
        entry.command === command &&
        entry.resume.some((selector) => selector === option),
    );
  if (agent) return { agent: agent.id, id };
  return;
}
