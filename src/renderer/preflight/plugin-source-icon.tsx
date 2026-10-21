/** Config provenance shared by agent and forge cards. */
export function PluginSourceIcon({ file }: { file: string }) {
  const label = `Foom config · ${file}`;
  return (
    <span className="plugin-source-icon" role="img" title={label} aria-label={label}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M9 5H3v6h2a2 2 0 1 1 0 4H3v6h6v-2a2 2 0 1 1 4 0v2h6v-6h2a2 2 0 1 0 0-4h-2V5h-6V3a2 2 0 1 0-4 0z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
