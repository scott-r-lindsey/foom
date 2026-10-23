export function OrchestrationMark({
  kind,
  related,
  label,
  title,
}: {
  kind: "tx" | "rx" | "review" | "orphan";
  related: boolean;
  label?: string;
  title?: string;
}) {
  const reviewer = kind === "review";
  const accessibleLabel = reviewer ? "Reviewer" : label;
  return (
    <svg
      className="session-robot-mark"
      data-kind={kind}
      data-related={related && kind !== "orphan"}
      viewBox="0 0 18 16"
      aria-hidden={accessibleLabel ? undefined : true}
      role={accessibleLabel ? "img" : undefined}
      aria-label={accessibleLabel}
    >
      {title && <title>{title}</title>}
      <rect className="robot-body" x={reviewer ? "3" : "4"} y="7" width="10" height="7.5" rx="2" />
      <path className="robot-body" d={reviewer ? "M8 7V4.6" : "M9 7V4.6"} />
      <circle className="robot-eye" cx={reviewer ? "8" : "9"} cy="4.2" r="1" />
      <circle className="robot-eye" cx={reviewer ? "6" : "7"} cy="10.6" r="1" />
      {reviewer ? (
        <>
          <circle className="robot-body robot-lens" cx="11.2" cy="10.4" r="2.6" />
          <circle className="robot-eye" cx="11.2" cy="10.4" r="1" />
          <path className="robot-body robot-handle" d="M13.1 12.3l2.4 2.4" />
        </>
      ) : (
        <circle className="robot-eye" cx="11" cy="10.6" r="1" />
      )}
      <path
        className="robot-wave robot-wave-inner"
        d={
          kind === "tx"
            ? "M6.6 2.6a3 3 0 0 0 0 3.2M11.4 2.6a3 3 0 0 1 0 3.2"
            : reviewer
              ? "M5.9 2.2a3 3 0 0 1 4.2 0"
              : "M6.9 2.2a3 3 0 0 1 4.2 0"
        }
      />
      <path
        className="robot-wave robot-wave-outer"
        d={
          kind === "tx"
            ? "M4.4 1.2a5.4 5.4 0 0 0 0 6M13.6 1.2a5.4 5.4 0 0 1 0 6"
            : reviewer
              ? "M4.2 0.6a5.4 5.4 0 0 1 7.6 0"
              : "M5.2 0.6a5.4 5.4 0 0 1 7.6 0"
        }
      />
    </svg>
  );
}
