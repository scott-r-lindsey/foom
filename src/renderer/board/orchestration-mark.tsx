export function OrchestrationMark({
  kind,
  related,
  label,
  title,
}: {
  kind: "tx" | "rx" | "orphan";
  related: boolean;
  label?: string;
  title?: string;
}) {
  return (
    <svg
      className="session-robot-mark"
      data-kind={kind}
      data-related={related && kind !== "orphan"}
      viewBox="0 0 18 16"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {title && <title>{title}</title>}
      <rect className="robot-body" x="4" y="7" width="10" height="7.5" rx="2" />
      <path className="robot-body" d="M9 7V4.6" />
      <circle className="robot-eye" cx="9" cy="4.2" r="1" />
      <circle className="robot-eye" cx="7" cy="10.6" r="1" />
      <circle className="robot-eye" cx="11" cy="10.6" r="1" />
      <path
        className="robot-wave robot-wave-inner"
        d={
          kind === "tx"
            ? "M6.6 2.6a3 3 0 0 0 0 3.2M11.4 2.6a3 3 0 0 1 0 3.2"
            : "M6.9 2.2a3 3 0 0 1 4.2 0"
        }
      />
      <path
        className="robot-wave robot-wave-outer"
        d={
          kind === "tx"
            ? "M4.4 1.2a5.4 5.4 0 0 0 0 6M13.6 1.2a5.4 5.4 0 0 1 0 6"
            : "M5.2 0.6a5.4 5.4 0 0 1 7.6 0"
        }
      />
    </svg>
  );
}
