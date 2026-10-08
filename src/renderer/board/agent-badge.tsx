/** Neutral UI shorthand, never vendor artwork. The parent supplies the full identity. */
export function AgentBadge({ mark }: { mark: string | undefined }) {
  return (
    <span className="board-agent" aria-hidden="true">
      <span>{mark || "?"}</span>
    </span>
  );
}
