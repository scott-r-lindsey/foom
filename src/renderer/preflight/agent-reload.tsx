export function AgentReload({
  name,
  busy,
  disabled,
  reload,
}: {
  name: string;
  busy: boolean;
  disabled?: boolean;
  reload: () => void;
}) {
  return (
    <button
      type="button"
      className="agent-reload"
      aria-label={`Re-check ${name}`}
      title={`Re-check ${name}`}
      disabled={busy || disabled}
      onClick={reload}
    >
      {busy ? (
        <span className="agent-reload-spinner" role="status" aria-label={`Checking ${name}`} />
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          aria-hidden="true"
        >
          <path d="M20 12a8 8 0 1 1-2.6-5.9M20 3v5h-5" />
        </svg>
      )}
    </button>
  );
}
