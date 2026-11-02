import { Fragment, useCallback, useEffect, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { CopyValue } from "../ui/copy-value";
import type {
  HostCheck,
  HostCheckProgress,
  HostFailure,
  HostPreflight,
  HostResult,
  HostRow,
  HostsAction,
  HostsState,
} from "../../shared/registered-hosts.d";
import type { SetupSource } from "./setup-source.d";
import type { Repository } from "../../shared/worktrees";
const reasons: Record<HostFailure, string> = {
  unreachable: "Host unreachable",
  "version-mismatch": "Host version mismatch",
  "provider-invalid": "Agent configuration unavailable",
  "configuration-changed": "Agent configuration changed",
  "invalid-reply": "Invalid host reply",
  cancelled: "Host check cancelled",
  unsupported: "Unsupported host platform",
  "facts-unavailable": "Host daemon needs an update for host facts",
  "libc-too-old": "Unsupported · glibc < 2.28",
  "libc-unsupported": "Unsupported · musl libc",
  "artifact-unavailable": "This build has no remote host support",
  "folder-missing": "Code folder does not exist",
  "folder-refused": "Code folder unavailable",
  "unsafe-folder": "Code folder ownership or permissions are unsafe",
  "origin-unavailable": "Repository origin unavailable",
  "origin-auth": "Origin authentication failed",
  "origin-host-key": "Origin SSH host key is not trusted",
  "origin-unreachable": "Origin unreachable",
  "timed-out": "Git operation timed out",
  "checkout-invalid": "Checkout validation failed",
  "clone-failed": "Could not clone from origin",
  "checkout-refused": "Checkout unavailable",
};

type Tone = "pass" | "need" | "fail" | "neutral" | "work";
function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`host-status host-${tone}`}>
      <span className="host-symbol" aria-hidden="true">
        {tone === "pass" ? "✓" : tone === "fail" ? "×" : tone === "neutral" ? "−" : ""}
      </span>
      <span>{children}</span>
    </span>
  );
}
function Row({
  name,
  tone,
  text,
  action,
}: {
  name: ReactNode;
  tone: Tone;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="host-check-row">
      <span className="host-check-name">{name}</span>
      <Status tone={tone}>{text}</Status>
      <span className="host-check-action">{action}</span>
    </div>
  );
}
function checkPresentation(
  check: HostCheck | undefined,
  pass: string,
): { tone: Tone; text: string } {
  if (check?.state === "pass") return { tone: "pass", text: `Pass · ${pass}` };
  if (check?.state === "fail")
    return { tone: "fail", text: `${reasons[check.reason]} · ${check.reason}` };
  return { tone: "neutral", text: "Not checked" };
}
function checkoutPresentation(result: HostResult | undefined): { tone: Tone; text: string } {
  if (!result) return { tone: "neutral", text: "Not checked" };
  if (!result.ok) return { tone: "fail", text: `${reasons[result.reason]} · ${result.reason}` };
  if (!result.checkout) return { tone: "neutral", text: "Not checked" };
  if (result.checkout.state === "absent") return { tone: "need", text: "Not checked out" };
  return {
    tone: result.checkout.state === "clean" ? "pass" : "neutral",
    text: result.checkout.state === "clean" ? "Clean" : "Changes",
  };
}
export function hostProgressText(progress: HostCheckProgress | undefined): string {
  if (!progress || progress.phase === "inspect") return "Checking host…";
  const index = progress.repositories.findIndex((repo) => repo.repository === progress.repository);
  const name = progress.repository?.split(/[\\/]/u).at(-1) ?? "";
  const step = progress.phase === "origin" ? "Checking Git access" : "Checking checkout";
  return `${step} · ${name} (${String(index + 1)} of ${String(progress.repositories.length)})`;
}
function hostSummary(preflight: HostPreflight | undefined) {
  if (!preflight) return "Not checked";
  const result = preflight.result;
  if (!result.ok) return "Needs you";
  const facts = result.facts;
  const checks = [preflight.ssh, preflight.platform, preflight.artifact, facts.folder];
  const inventory = [...(facts.tools ?? []), ...facts.agents];
  const mac = facts.requirements?.mac;
  return !facts.tools ||
    checks.some((check) => check?.state !== "pass") ||
    inventory.some(
      (tool) => tool.state !== "ready" || (tool.id !== "git" && tool.signIn !== "signed-in"),
    ) ||
    preflight.repositories.some(
      (repo) =>
        repo.origin.state !== "pass" ||
        !repo.checkout.ok ||
        !repo.checkout.checkout ||
        repo.checkout.checkout.state === "absent",
    ) ||
    (mac && (!mac.commandLineTools || mac.protectedFolder || !mac.staysAwake))
    ? "Needs you"
    : "Complete";
}
function canClone(result: HostResult | undefined) {
  return (
    result &&
    (result.ok
      ? result.checkout?.state === "absent"
      : [
          "clone-failed",
          "origin-auth",
          "origin-host-key",
          "origin-unreachable",
          "timed-out",
          "checkout-invalid",
        ].includes(result.reason))
  );
}
function Group({ children }: { children: ReactNode }) {
  return <h4 className="host-check-group">{children}</h4>;
}
const agentNames = new Map<string, string>([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["agy", "Antigravity"],
  ["pi", "Pi"],
  ["opencode", "OpenCode"],
]);
function Checklist({
  entry,
  preflight,
  checking,
  progress,
  disabled,
  act,
  changeFolder,
}: {
  entry: HostRow;
  preflight: HostPreflight | undefined;
  checking: boolean;
  progress: HostCheckProgress | undefined;
  disabled: boolean;
  act: (action: HostsAction) => void;
  changeFolder: () => void;
}) {
  const result = progress?.result ?? preflight?.result ?? entry.result;
  const facts = result?.ok ? result.facts : undefined;
  const mac = facts?.requirements?.mac;
  const connection = progress?.result
    ? progress.result.connection
    : (preflight ?? result?.connection);
  const folder = facts?.folder;
  const folderStatus = checkPresentation(folder, "Valid");
  if (mac?.protectedFolder) {
    if (folder?.state !== "fail") folderStatus.tone = "need";
    folderStatus.text =
      folder?.state === "fail"
        ? `${folderStatus.text} · Protected folder`
        : "Warning · Protected folder";
  }
  const recipe = (id: string, operation: "install" | "sign-in") => (
    <button
      type="button"
      disabled={disabled}
      aria-label={`${operation === "install" ? "Install" : "Sign in"} ${id}`}
      onClick={() => {
        act({ action: "recipe", host: entry.host, tool: id, operation });
      }}
    >
      {operation === "install" ? "Install" : "Sign in"}
    </button>
  );
  const tools = (
    agents: readonly {
      id: string;
      state: "ready" | "missing" | "unable";
      signIn?: "signed-in" | "signed-out" | "unknown";
    }[],
  ) =>
    agents.map((agent) => {
      const available = entry.recipes?.find((item) => item.tool === agent.id);
      const needsCLT = agent.id === "git" && mac && !mac.commandLineTools;
      return (
        <Fragment key={agent.id}>
          <Row
            name={agentNames.get(agent.id) ?? agent.id}
            tone={
              needsCLT || agent.state === "missing"
                ? "need"
                : agent.state === "ready"
                  ? "pass"
                  : "neutral"
            }
            text={
              needsCLT
                ? "Needs Command Line Tools"
                : agent.state === "ready"
                  ? "Pass · Installed"
                  : agent.state === "missing"
                    ? "Not found"
                    : "Unable to check"
            }
            action={
              !needsCLT && agent.state === "missing" && available?.install
                ? recipe(agent.id, "install")
                : undefined
            }
          />
          {agent.id !== "git" && agent.state === "ready" && (
            <Row
              name={
                <>
                  {agentNames.get(agent.id) ?? agent.id} sign-in{" "}
                  {agent.id === "gh" && <span className="host-tag">PRs</span>}
                </>
              }
              tone={
                agent.signIn === "signed-in"
                  ? "pass"
                  : agent.signIn === "signed-out"
                    ? "need"
                    : "neutral"
              }
              text={
                agent.signIn === "signed-in"
                  ? "Pass · Signed in"
                  : agent.signIn === "signed-out"
                    ? "Signed out"
                    : "Sign-in unknown"
              }
              action={
                agent.signIn !== "signed-in" && available?.signIn
                  ? recipe(agent.id, "sign-in")
                  : undefined
              }
            />
          )}
        </Fragment>
      );
    });
  const repositories = progress?.repositories ?? preflight?.repositories ?? [];
  return (
    <div className="host-checks" aria-busy={checking}>
      <Group>Host</Group>
      <Row name="SSH" {...checkPresentation(connection?.ssh, "Host key trusted")} />
      <Row name="Platform" {...checkPresentation(connection?.platform, "Supported")} />
      <Row name="Remote daemon" {...checkPresentation(connection?.artifact, "In this build")} />
      <Row
        name="Code folder"
        {...folderStatus}
        action={
          <>
            {folder?.state === "fail" && folder.reason === "folder-missing" && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  act({ action: "create-folder", host: entry.host });
                }}
              >
                Create
              </button>
            )}
            <button type="button" disabled={disabled} onClick={changeFolder}>
              Change folder
            </button>
          </>
        }
      />
      {result &&
        !result.ok &&
        ![connection?.ssh, connection?.platform, connection?.artifact].some(
          (check) => check?.state === "fail" && check.reason === result.reason,
        ) && (
          <p className="hosts-failure" role="status">
            {reasons[result.reason]}
          </p>
        )}
      <Group>Tools</Group>
      {mac && (
        <Row
          name="Command Line Tools"
          tone={mac.commandLineTools ? "pass" : "need"}
          text={mac.commandLineTools ? "Pass · Installed" : "Not found"}
          action={!mac.commandLineTools ? "Do this on the Mac" : undefined}
        />
      )}
      {facts?.tools ? (
        tools(facts.tools)
      ) : (
        <Row name="git / gh" tone="neutral" text="Not checked" />
      )}
      <Group>Agents</Group>
      {facts ? tools(facts.agents) : <Row name="Agents" tone="neutral" text="Not checked" />}
      {repositories.map((repo) => (
        <Fragment key={repo.repository}>
          <Group>Repository · {repo.repository.split(/[\\/]/u).at(-1)}</Group>
          <Row
            name="Git access to origin"
            {...(checking && !repo.origin
              ? { tone: "work" as const, text: "Checking…" }
              : checkPresentation(repo.origin, "Reachable"))}
          />
          {repo.origin?.state === "fail" && repo.origin.reason === "origin-auth" && (
            <div className="host-origin-fixes" aria-label="Git access fixes">
              <span
                title={
                  'Run gh auth setup-git, then git config --global url."https://github.com/".insteadOf git@github.com: on this host'
                }
              >
                Use HTTPS through gh
              </span>
              <span title="Add a passphrase-less deploy key on this host">deploy key</span>
              <span title="Load the key in a persistent ssh-agent visible to the host login environment">
                ssh-agent
              </span>
            </div>
          )}
          <Row
            name="Repository checkout"
            {...(checking && !repo.checkout
              ? { tone: "work" as const, text: "Checking…" }
              : checkoutPresentation(repo.checkout))}
            action={
              canClone(repo.checkout) ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    act({ action: "clone", host: entry.host, repository: repo.repository });
                  }}
                >
                  Clone here
                </button>
              ) : undefined
            }
          />
        </Fragment>
      ))}
      {mac && (
        <>
          <Group>Power</Group>
          <Row
            name="Stays awake"
            tone={mac.staysAwake ? "pass" : "need"}
            text={mac.staysAwake ? "Pass · Stays awake" : "Warning · Sleeps when idle"}
            action={!mac.staysAwake ? "On the Mac · Battery → Options" : undefined}
          />
        </>
      )}
    </div>
  );
}
export function HostsSettings({
  source,
  headingRef,
}: {
  source: Pick<SetupSource, "hosts" | "copyHost">;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [state, setState] = useState<HostsState>({ hosts: [], locations: [] });
  const [checks, setChecks] = useState<ReadonlyMap<string, HostPreflight>>(
    () => new Map<string, HostPreflight>(),
  );
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState("");
  const [folder, setFolder] = useState("~/foom");
  const [changing, setChanging] = useState<{ host: string; folder: string }>();
  const [busy, setBusy] = useState<string | undefined>("");
  const [error, setError] = useState("");
  const api = source.hosts;
  const [checkingHost, setCheckingHost] = useState<string>();
  const [progress, setProgress] = useState<HostCheckProgress>();
  useEffect(() => {
    if (!checkingHost || !api) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api({ action: "progress" });
        if (active && next.progress?.host === checkingHost) setProgress(next.progress);
      } catch {
        // The authoritative preflight request owns error reporting.
      }
      if (active)
        timer = setTimeout(() => {
          void poll();
        }, 250);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, checkingHost]);
  const runCheck = useCallback(
    async (host: string, codeFolder: string) => {
      setProgress(undefined);
      setCheckingHost(host);
      try {
        return await api?.({ action: "preflight", host, codeFolder });
      } finally {
        setCheckingHost(undefined);
        setProgress(undefined);
      }
    },
    [api],
  );
  useEffect(() => {
    let active = true;
    const current = () => active;
    void (async () => {
      try {
        const initial = await api?.({ action: "list" });
        if (!current() || !initial) return;
        setState(initial);
        for (const entry of initial.hosts) {
          setBusy(entry.host);
          const next = await runCheck(entry.host, entry.codeFolder);
          if (!current()) return;
          if (next) {
            setState(next);
            const preflight = next.preflight;
            if (preflight) setChecks((previous) => new Map(previous).set(entry.host, preflight));
          }
        }
      } catch {
        if (current()) setError("Unable to load hosts");
      } finally {
        if (current()) setBusy(undefined);
      }
    })();
    return () => {
      active = false;
    };
  }, [api, runCheck]);
  const act = async (action: HostsAction) => {
    setBusy("host" in action ? action.host : "");
    setError("");
    try {
      let next =
        action.action === "preflight"
          ? await runCheck(action.host, action.codeFolder)
          : await api?.(action);
      if (!next) return;
      setState(next);
      if (action.action === "preflight" && next.preflight) {
        const preflight = next.preflight;
        setChecks((previous) => new Map(previous).set(action.host, preflight));
      }
      if (next.recipeFailure) setError("Recipe unavailable for this host");
      if (action.action === "add" && next.hosts.some((entry) => entry.host === action.host)) {
        setAdding(false);
        setHost("");
        setFolder("~/foom");
      } else if (action.action === "add" && next.result && !next.result.ok)
        setError(reasons[next.result.reason]);
      if (action.action === "change-folder") setChanging(undefined);
      if (
        (action.action === "change-folder" || action.action === "create-folder") &&
        next.result &&
        !next.result.ok
      )
        setError(reasons[next.result.reason]);
      const cloneResult =
        action.action === "clone"
          ? next.locations.find(
              (location) =>
                location.host === action.host && location.repository === action.repository,
            )?.result
          : undefined;
      if ("host" in action && !["remove", "recipe", "end", "preflight"].includes(action.action)) {
        const entry = next.hosts.find((entry) => entry.host === action.host);
        if (entry) {
          next = await runCheck(entry.host, entry.codeFolder);
          if (next) {
            setState(next);
            const observed = next.preflight;
            const preflight =
              observed &&
              action.action === "clone" &&
              cloneResult &&
              !cloneResult.ok &&
              cloneResult.reason !== "unreachable"
                ? {
                    ...observed,
                    repositories: observed.repositories.map((repo) =>
                      repo.repository === action.repository
                        ? { ...repo, checkout: cloneResult }
                        : repo,
                    ),
                  }
                : observed;
            if (preflight) setChecks((previous) => new Map(previous).set(entry.host, preflight));
          }
        }
      }
    } catch {
      setError("Unable to update hosts");
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="hosts-page">
      <header className="hosts-heading">
        <h2 ref={headingRef} tabIndex={-1}>
          Hosts
        </h2>
        {!adding && (
          <button
            type="button"
            disabled={busy !== undefined}
            onClick={() => {
              setAdding(true);
            }}
          >
            Add host
          </button>
        )}
      </header>
      {error && (
        <p role="alert" className="hosts-failure">
          {error}
        </p>
      )}
      {adding && (
        <form
          className="host-card host-add"
          onSubmit={(event) => {
            event.preventDefault();
            void act({ action: "add", host: host.trim(), codeFolder: folder });
          }}
        >
          <h3>Add host</h3>
          <fieldset disabled={busy !== undefined} className="host-add-fields">
            <label>
              SSH host
              <input
                placeholder="user@host"
                value={host}
                onChange={(event) => {
                  setHost(event.target.value);
                }}
              />
            </label>
            <label>
              Code folder
              <input
                value={folder}
                onChange={(event) => {
                  setFolder(event.target.value);
                }}
              />
            </label>
            <button type="submit" disabled={!host.trim()}>
              Add host
            </button>
            <span className="host-notice">Host key trusted outside Foom</span>
          </fieldset>
          <button
            className="host-cancel"
            type="button"
            disabled={busy !== undefined}
            onClick={() => {
              setAdding(false);
            }}
          >
            Cancel
          </button>
          {busy !== undefined && <p role="status">Checking…</p>}
        </form>
      )}
      {!state.hosts.length && !adding && <p>No hosts</p>}
      {state.hosts.map((entry) => (
        <section className="host-card" key={entry.host} aria-label={entry.host}>
          <header className="hosts-heading">
            <h3>
              <CopyValue
                value={entry.host}
                label="Copy host alias"
                copy={() =>
                  source.copyHost?.({ kind: "copy-host-alias", host: entry.host }) ??
                  Promise.reject(new Error("Copy unavailable"))
                }
              />
            </h3>
            <span className="host-count">
              {busy === entry.host ? "Checking…" : hostSummary(checks.get(entry.host))}
            </span>
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={() => {
                void act({ action: "remove", host: entry.host });
              }}
            >
              Remove
            </button>
          </header>
          <div className="host-meta">
            <span>
              {entry.result?.ok
                ? entry.result.facts.requirements?.distro === "darwin"
                  ? "macOS"
                  : entry.result.facts.requirements?.distro
                : ""}
            </span>
            <code>
              <CopyValue
                value={entry.codeFolder}
                label="Copy code folder"
                copy={() =>
                  source.copyHost?.({ kind: "copy-host-code-folder", host: entry.host }) ??
                  Promise.reject(new Error("Copy unavailable"))
                }
              />
            </code>
          </div>
          <Checklist
            entry={entry}
            preflight={checks.get(entry.host)}
            progress={checkingHost === entry.host ? progress : undefined}
            checking={checkingHost === entry.host}
            disabled={busy !== undefined}
            act={(action) => {
              void act(action);
            }}
            changeFolder={() => {
              setChanging({ host: entry.host, folder: entry.codeFolder });
            }}
          />
          {changing?.host === entry.host && (
            <form
              className="host-folder-form"
              onSubmit={(event) => {
                event.preventDefault();
                void act({
                  action: "change-folder",
                  host: entry.host,
                  codeFolder: changing.folder,
                });
              }}
            >
              <label>
                Code folder
                <input
                  value={changing.folder}
                  onChange={(event) => {
                    setChanging({ host: entry.host, folder: event.target.value });
                  }}
                />
              </label>
              <button type="submit" disabled={busy !== undefined || !changing.folder.trim()}>
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setChanging(undefined);
                }}
              >
                Cancel
              </button>
            </form>
          )}
          <footer className="host-footer">
            <span className="host-count">
              {busy === entry.host ? (
                <span className="host-check-progress host-work" role="status">
                  <span className="host-throbber" aria-hidden="true" />
                  {hostProgressText(checkingHost === entry.host ? progress : undefined)}
                </span>
              ) : entry.result?.ok && entry.result.facts.requirements?.packageManager === "none" ? (
                "No install recipe"
              ) : checks.get(entry.host) ? (
                "Check complete"
              ) : (
                "Not checked"
              )}
            </span>
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={() => {
                void act({ action: "preflight", host: entry.host, codeFolder: entry.codeFolder });
              }}
            >
              Check again
            </button>
          </footer>
          <details className="host-details">
            <summary>Host facts</summary>
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={() => {
                void act({ action: "refresh", host: entry.host });
              }}
            >
              Refresh facts
            </button>
            {entry.foreignWorktrees !== undefined && (
              <p>{entry.foreignWorktrees} other worktrees</p>
            )}
            {entry.foreignSessions !== undefined && (
              <p>
                <span>Other profiles or untagged: {entry.foreignSessions}</span>{" "}
                {entry.foreignSessions > 0 && (
                  <button
                    type="button"
                    disabled={busy !== undefined}
                    onClick={() => {
                      void act({ action: "end", host: entry.host });
                    }}
                  >
                    End…
                  </button>
                )}
              </p>
            )}
            {entry.result?.ok && (
              <dl className="host-facts">
                {Object.entries({
                  Daemon: entry.result.facts.version,
                  "Live sessions": entry.result.facts.sessions,
                  "CPU cores": entry.result.facts.cores,
                  "Load average": entry.result.facts.load
                    .map((value) => value.toFixed(2))
                    .join(" · "),
                  "Memory total": `${(entry.result.facts.memoryTotal / 1024 ** 3).toFixed(1)} GiB`,
                  "Memory available": `${(entry.result.facts.memoryAvailable / 1024 ** 3).toFixed(1)} GiB`,
                }).map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </details>
        </section>
      ))}
    </div>
  );
}
export function RepositoryHosts({
  source,
  repositories,
  headingRef,
}: {
  source: Pick<SetupSource, "hosts" | "copyHost">;
  repositories: readonly Repository[];
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const [state, setState] = useState<HostsState>({ hosts: [], locations: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const api = source.hosts;
  useEffect(() => {
    let active = true;
    void api?.({ action: "locations" }).then(
      (next) => {
        if (active) setState(next);
      },
      () => {
        if (active) setError("Unable to check locations");
      },
    );
    return () => {
      active = false;
    };
  }, [api, repositories]);
  const act = async (action: HostsAction) => {
    setBusy(true);
    setError("");
    try {
      let next = await api?.(action);
      if (
        action.action === "clone" &&
        next?.locations.some(
          (entry) =>
            entry.host === action.host &&
            entry.repository === action.repository &&
            !entry.result.ok &&
            entry.result.reason === "unreachable",
        )
      )
        next = await api?.({ action: "locations" });
      if (next) setState(next);
    } catch {
      setError(
        action.action === "clone" ? "Unable to clone repository" : "Unable to check locations",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="repository-hosts" aria-label="Repository locations">
      <header className="hosts-heading">
        <h2 ref={headingRef} tabIndex={-1}>
          Repositories
        </h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void act({ action: "locations" });
          }}
        >
          Refresh locations
        </button>
      </header>
      {error && (
        <p role="alert" className="hosts-failure">
          {error}
        </p>
      )}
      {[{ host: null, codeFolder: "" }, ...state.hosts].map((host) => (
        <section
          className="host-card repository-host-card"
          key={host.host ?? "local"}
          aria-label={host.host ?? "Local"}
        >
          <header className="hosts-heading">
            <h3>{host.host ?? "Local"}</h3>
            <span className="host-tag">
              {repositories.length} {repositories.length === 1 ? "repository" : "repositories"}
            </span>
            <code>{host.codeFolder}</code>
          </header>
          {repositories.map((repo) => {
            const result = state.locations.find(
              (entry) => entry.host === host.host && entry.repository === repo.path,
            )?.result;
            const checkout = result?.ok ? result.checkout : undefined;
            const path = host.host === null ? repo.path : checkout?.path;
            return (
              <div className="host-repository-row" key={repo.path}>
                <span>{repo.name}</span>
                <code>
                  {path && (
                    <CopyValue
                      value={path}
                      label="Copy checkout path"
                      copy={() =>
                        source.copyHost?.({
                          kind: "copy-checkout-path",
                          host: host.host,
                          repository: repo.path,
                        }) ?? Promise.reject(new Error("Copy unavailable"))
                      }
                    />
                  )}
                </code>
                <Status
                  {...(host.host === null
                    ? { tone: "neutral" as const }
                    : { tone: checkoutPresentation(result).tone })}
                >
                  {host.host === null ? "Checked out" : checkoutPresentation(result).text}
                </Status>
                <span className="host-check-action">
                  {host.host !== null && canClone(result) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (host.host)
                          void act({ action: "clone", host: host.host, repository: repo.path });
                      }}
                    >
                      Clone here
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </section>
      ))}
    </section>
  );
}
