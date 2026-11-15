import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RepositorySetupAction,
  RepositorySetupState,
  SetupDistro,
} from "../../shared/repository-setup.d";
import { setupArtifact, setupCatalog, setupPlan } from "../../shared/repository-setup-catalog";
import { parseSetupList, setupDistros } from "../../shared/repository-setup";
import type { SetupSource } from "./setup-source.d";
import { HostTerminal } from "./host-terminal";

const states = {
  "no-list": "No setup list",
  "not-checked": "Not checked",
  met: "Requirements met",
  "needs-setup": "Needs setup",
  "review-needed": "Review needed",
  unable: "Unable to check",
  manual: "Manual setup required",
};
const empty = JSON.stringify({ requirements: [], evidence: [] }, null, 2);
const name = (path: string) => path.split(/[\\/]/u).at(-1) || path;
type Source = Pick<SetupSource, "repositorySetup" | "hostTerminal" | "draftSetupAgent">;
/** Each panel reads saved observations on mount; only explicit gestures inspect a host. */
export function RepositorySetupPanel({
  source,
  host,
  repository,
  targetRepository,
  refreshVersion,
}: {
  source: Source;
  host: string | null;
  repository?: string;
  targetRepository?: string;
  refreshVersion?: number | undefined;
}) {
  const targetRef = useRef<HTMLDivElement>(null);
  const focusedTargetRef = useRef<string | undefined>(undefined);
  const api = source.repositorySetup;
  const [state, setState] = useState<RepositorySetupState>({ rows: [] });
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState(empty);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [distro, setDistro] = useState<SetupDistro>("debian");
  const [session, setSession] = useState<{ id: string; repository: string }>();
  useEffect(() => {
    let live = true;
    void api?.({ action: "list" })
      .then((value) => {
        if (live) setState(value);
      })
      .catch(() => {
        if (live) setError("Unable to read setup lists");
      });
    return () => {
      live = false;
    };
  }, [api, refreshVersion]);
  const act = async (action: RepositorySetupAction) => {
    if (!api) return;
    setBusy(true);
    setError("");
    try {
      const next = await api(action);
      setState(next);
      if (action.action === "run" && next.recipeSession) {
        const row = state.rows.find((row) => row.token === action.token);
        if (row) setSession({ id: next.recipeSession, repository: row.repository });
      }
      if (action.action === "approve" || action.action === "remove") setEditing(undefined);
    } catch {
      setError("Setup changed or could not be saved. Reload the row, or review the draft again.");
    } finally {
      setBusy(false);
    }
  };
  const finished = useCallback(() => {
    if (!session) return;
    void api?.({ action: "check", repository: session.repository, host })
      .then(setState)
      .catch(() => {
        setError("Unable to check/save setup after exit");
      });
  }, [api, host, session]);
  useEffect(() => {
    if (targetRepository && targetRef.current && focusedTargetRef.current !== targetRepository) {
      focusedTargetRef.current = targetRepository;
      targetRef.current.scrollIntoView({ block: "center" });
      targetRef.current.focus({ preventScroll: true });
    }
  }, [targetRepository, state.rows]);
  if (!api) return null;
  const review = state.review;
  const rows = state.rows.filter(
    (row) => row.host === host && (!repository || row.repository === repository),
  );
  const addRequirement = (tool?: "node" | "pnpm") => {
    try {
      const value = parseSetupList(draft);
      const id = `${tool ?? "packages"}-${String(value.requirements.length + 1)}`;
      const requirement = tool
        ? {
            kind: "toolchain",
            id,
            tool,
            version: tool === "node" ? "24.x" : setupCatalog.pnpm.version,
            purpose: "Explain why this repository needs this tool",
            sources: [],
          }
        : {
            kind: "package",
            id,
            purpose: "Explain why this repository needs these packages",
            sources: [],
            packages: { debian: [], rhel: [], arch: [], darwin: [] },
          };
      setDraft(
        JSON.stringify({ ...value, requirements: [...value.requirements, requirement] }, null, 2),
      );
    } catch {
      setError("Import valid structured JSON before adding a requirement");
    }
  };
  return (
    <section className="repository-setup" aria-label="Repository setup">
      <h4>Repository setup</h4>
      {error && (
        <p className="hosts-failure" role="alert">
          {error}
        </p>
      )}
      {editing ? (
        <div className="repository-setup-editor">
          <button
            type="button"
            onClick={() => {
              setEditing(undefined);
              setState({ rows: state.rows });
              void act({ action: "cancel-review", keepDraft: false });
            }}
          >
            ← Back to {host ?? "This computer"}
          </button>
          <h3>{name(editing)} · Setup list</h3>
          <p>
            Saved in Foom’s profile. Approval installs nothing. Repository scripts and application
            dependencies are outside this list.
          </p>
          {!review ? (
            <>
              <details>
                <summary>Draft with an agent</summary>
                <p>
                  Read build documentation and manifests as text. Do not install anything or request
                  sudo. Return structured requirements, evidence paths and uncertainties. No
                  commands, URLs, secrets or approval.
                </p>
                <p>
                  The agent retains its existing permissions. Repository material may reach its
                  provider under its settings.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    void act({ action: "copy-brief" });
                  }}
                >
                  Copy draft brief
                </button>
                {source.draftSetupAgent && (
                  <button
                    type="button"
                    onClick={() => {
                      void source.draftSetupAgent?.(editing).catch(() => {
                        setError(
                          "Choose a default agent in Agents, or use an existing repository agent.",
                        );
                      });
                    }}
                  >
                    Open repository agent…
                  </button>
                )}
              </details>
              <p>
                Write a list, or paste an agent’s JSON suggestion. Package mappings are required for
                every distribution; use “unsupported” explicitly where needed.
              </p>
              <div className="repository-setup-actions">
                <button
                  type="button"
                  onClick={() => {
                    addRequirement();
                  }}
                >
                  Add OS packages
                </button>
                <button
                  type="button"
                  onClick={() => {
                    addRequirement("node");
                  }}
                >
                  Add Node
                </button>
                <button
                  type="button"
                  onClick={() => {
                    addRequirement("pnpm");
                  }}
                >
                  Add pnpm
                </button>
              </div>
              <label>
                Import draft · JSON
                <textarea
                  aria-label="Setup draft JSON"
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                  spellCheck={false}
                />
              </label>
              <div className="repository-setup-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void act({ action: "review", repository: editing, draft });
                  }}
                >
                  Review draft
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void act({ action: "remove", repository: editing });
                  }}
                >
                  Remove setup list
                </button>
              </div>
            </>
          ) : (
            <>
              <h3>Review setup draft · revision {review.revision + 1}</h3>
              {review.unresolved?.map((item) => (
                <div className="repository-setup-needs" key={item.id}>
                  <strong>
                    Unresolved · {item.id} · {item.tool} {item.version}
                  </strong>
                  <p>{item.purpose}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(
                        JSON.stringify(
                          {
                            ...review.list,
                            requirements: [
                              ...review.list.requirements,
                              ...(review.unresolved ?? []),
                            ].filter((entry) => entry.id !== item.id),
                          },
                          null,
                          2,
                        ),
                      );
                      setState({ rows: state.rows });
                      void act({ action: "cancel-review", keepDraft: true });
                    }}
                  >
                    Remove requirement {item.id}
                  </button>
                </div>
              ))}
              {!!review.removed?.length && (
                <p>Removed unresolved requirements · {review.removed.join(", ")}</p>
              )}
              <p>Review all distribution mappings, toolchains and evidence before approving.</p>
              {review.list.requirements.length === 0 && <p>No host requirements</p>}
              {review.list.requirements.map((item) => (
                <div className="repository-setup-requirement" key={item.id}>
                  <strong>{item.id}</strong>
                  <p>{item.purpose}</p>
                  {item.kind === "package" ? (
                    setupDistros.map((mapping) => (
                      <div key={mapping}>
                        <strong>{mapping}</strong> ·{" "}
                        <code>
                          {item.packages[mapping] === "unsupported"
                            ? "Unsupported"
                            : item.packages[mapping].join(" ") || "No packages"}
                        </code>
                      </div>
                    ))
                  ) : (
                    <p>
                      {item.tool} · {item.version} · Catalog {setupCatalog[item.tool].version}
                    </p>
                  )}
                  <small>Evidence · {item.sources.join(" · ") || "No source paths supplied"}</small>
                </div>
              ))}
              <details open>
                <summary>Changes against active revision</summary>
                <pre>
                  {JSON.stringify({ before: review.previous ?? null, after: review.list }, null, 2)}
                </pre>
                <p>Changed evidence: {review.changed.join(" · ") || "None"}</p>
              </details>
              <label>
                Preview distribution{" "}
                <select
                  value={distro}
                  onChange={(event) => {
                    const selected = setupDistros.find((value) => value === event.target.value);
                    if (selected) setDistro(selected);
                  }}
                >
                  {setupDistros.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <pre>
                {JSON.stringify(
                  setupPlan(review.list, {
                    platform: {
                      distro,
                      os: distro === "darwin" ? "darwin" : "linux",
                      arch: "x64",
                      nodeAbi: true,
                    },
                    items: review.list.requirements.map((item) => ({
                      id: item.id,
                      state: "missing",
                    })),
                  })?.steps ?? "Manual setup required; no catalog recipe",
                  null,
                  2,
                )}
              </pre>
              <p>
                Package steps use sudo and network downloads. Pinned toolchains affect only this
                repository’s launch PATH. No shell startup files are edited.
              </p>
              {review.list.requirements
                .flatMap((item) => (item.kind === "toolchain" ? [item] : []))
                .map((item) => (
                  <details key={item.id}>
                    <summary>{item.tool} · exact artifact and integrity</summary>
                    {["x64", "arm64"].map((arch) => {
                      const artifact = setupArtifact(item.tool, {
                        distro,
                        os: distro === "darwin" ? "darwin" : "linux",
                        arch: arch === "x64" ? "x64" : "arm64",
                        nodeAbi: true,
                      });
                      return (
                        <pre key={arch}>
                          {arch} · {artifact?.url ?? "Unsupported"}
                          {"\n"}
                          {artifact?.algorithm}: {artifact?.digest}
                        </pre>
                      );
                    })}
                  </details>
                ))}
              <p>Reviewed sources · {review.sources.files.map((file) => file.path).join(" · ")}</p>
              <div className="repository-setup-actions">
                <button
                  type="button"
                  onClick={() => {
                    void act({ action: "cancel-review", keepDraft: true });
                    setDraft(
                      JSON.stringify(
                        {
                          ...review.list,
                          requirements: [...review.list.requirements, ...(review.unresolved ?? [])],
                        },
                        null,
                        2,
                      ),
                    );
                    setState({ rows: state.rows });
                  }}
                >
                  Edit draft
                </button>
                <button
                  type="button"
                  disabled={busy || !!review.unresolved?.length}
                  onClick={() => {
                    void act({ action: "approve", token: review.token });
                  }}
                >
                  {review.previous &&
                  JSON.stringify(review.previous) === JSON.stringify(review.list)
                    ? "Keep list"
                    : "Approve list"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(undefined);
                    setState({ rows: state.rows });
                    void act({ action: "cancel-review", keepDraft: false });
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        rows.map((row) => (
          <div
            className="repository-setup-row"
            key={row.repository}
            tabIndex={-1}
            ref={row.repository === targetRepository ? targetRef : undefined}
          >
            <div>
              <strong>{name(row.repository)}</strong>
              <small>
                {row.revision
                  ? `Approved list · revision ${String(row.revision)}`
                  : "Host requirements unknown"}
              </small>
            </div>
            <div>
              <span
                className={
                  row.state === "needs-setup" || row.state === "review-needed"
                    ? "repository-setup-needs"
                    : row.state === "met"
                      ? "repository-setup-met"
                      : ""
                }
              >
                {row.state === "met"
                  ? "✓ "
                  : row.state === "needs-setup" || row.state === "review-needed"
                    ? "◉ "
                    : "○ "}
                {states[row.state]}
              </span>
              {row.missing.length > 0 && (
                <small>
                  {row.state === "unable"
                    ? "Last observed missing requirements"
                    : "Missing requirements"}{" "}
                  · {row.missing.join(", ")}
                </small>
              )}
              {row.noRequirements && <small>No host requirements</small>}
              {row.changed.length > 0 && <small>Changed sources · {row.changed.join(", ")}</small>}
              <small>
                {row.checkedAt
                  ? `Row checked ${new Date(row.checkedAt).toLocaleString()}`
                  : "Not checked"}
                {row.sourcesAtLaunch ? " · Sources checked at first launch" : ""}
              </small>
              {row.failure && (
                <small className="hosts-failure">Unable to check/save · {row.failure}</small>
              )}
              {row.running && <small>{row.running}</small>}
            </div>
            <div className="repository-setup-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(row.repository);
                  setDraft(empty);
                  if (row.revision) void act({ action: "review", repository: row.repository });
                }}
              >
                {row.state === "no-list" ? "Create list" : "Review list"}
              </button>
              {row.token && !row.running && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (row.token) void act({ action: "run", token: row.token });
                  }}
                >
                  Set up
                </button>
              )}
              <button
                type="button"
                disabled={busy || !!row.running}
                aria-label={`Recheck ${name(row.repository)} setup on ${host ?? "This computer"}`}
                onClick={() => {
                  void act({ action: "check", repository: row.repository, host });
                }}
              >
                ↻
              </button>
            </div>
            {row.plan && (
              <details>
                <summary>What will Set up do?</summary>
                <pre>{JSON.stringify(row.plan.steps, null, 2)}</pre>
                <p>
                  Uses network downloads and sudo for OS packages. Installs only unmet approved
                  requirements.
                </p>
              </details>
            )}
            {row.state === "manual" && (
              <p>
                Unsupported platform, mapping, ABI or catalog version. Set up these requirements
                manually, then recheck.
              </p>
            )}
            {row.state === "met" && (
              <p>Approved requirements observed. This does not guarantee a successful build.</p>
            )}
          </div>
        ))
      )}
      {session && source.hostTerminal && (
        <HostTerminal
          key={session.id}
          id={session.id}
          source={source.hostTerminal}
          finished={finished}
        />
      )}
    </section>
  );
}
