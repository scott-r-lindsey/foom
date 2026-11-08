/** Fixed neutral/positive icons accompany status words; color never carries status alone. */
export function AgentStatus({ text }: { text: string }) {
  return (
    <span className={`agent-status${text === "Signed in" ? " agent-status-ready" : ""}`}>
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        {text === "Signed in" ? <path d="m3 8 3 3 7-7" /> : <circle cx="8" cy="8" r="5.5" />}
        {text === "Signed out" && <path d="M5 8h6" />}
      </svg>
      <span>{text}</span>
    </span>
  );
}
