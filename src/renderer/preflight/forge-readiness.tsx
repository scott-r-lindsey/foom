import type { ReadinessReport } from "../../shared/readiness";

const labels = {
  ready: "Ready",
  "not-installed": "Not installed",
  "not-signed-in": "Not signed in",
  unavailable: "Unable to check",
  unassigned: "PR status is unavailable for this host",
};
export function ForgeReadinessRows({
  report,
  openSettings,
  commands,
  assignments,
}: {
  report: ReadinessReport | undefined;
  openSettings?: () => void;
  commands?: ReadonlyMap<string, string>;
  assignments?: Readonly<Record<string, string>>;
}) {
  return (
    <>
      <p className="preflight-intro">
        Forge checks use your CLI’s auth status command, which may contact its host. Sign-in stays
        yours.
      </p>
      <ul className="preflight-poll">
        {report?.forges.map(({ host, status }) => (
          <li key={host}>
            <span className="preflight-system">{host}</span>
            <span
              className="preflight-detail"
              data-attention={status === "not-installed" || status === "not-signed-in"}
            >
              {labels[status]}
              {status === "not-signed-in" &&
                (commands?.get(assignments?.[host] ?? "") || assignments?.[host] === "github") && (
                  <>
                    {" "}
                    · Run <code>{commands?.get(assignments?.[host] ?? "") ?? "gh auth login"}</code>
                  </>
                )}
              {openSettings && (
                <>
                  {" "}
                  ·{" "}
                  <button type="button" className="link" onClick={openSettings}>
                    Settings → Forges
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
