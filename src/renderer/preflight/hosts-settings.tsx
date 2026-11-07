import { hostDisplayName, hostNicknameError } from "../../shared/registered-hosts";
import { Fragment, createContext, use, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { CopyValue } from "../ui/copy-value";
import type {
  HostCheckTarget,
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
const ReloadContext = createContext<
  | {
      reload: (target: HostCheckTarget) => void;
      pending: ReadonlySet<string>;
      failed: ReadonlySet<string>;
      saveFailed: ReadonlySet<string>;
      needsFullCheck: boolean;
    }
  | undefined
>(undefined);
const rowKey = (target: HostCheckTarget) => JSON.stringify(target);
function reloadName(target: HostCheckTarget): string {
  if ("tool" in target)
    return `${agentNames.get(target.tool) ?? target.tool}${target.kind === "sign-in" ? " sign-in" : ""}`;
  if ("repository" in target)
    return `${target.kind === "origin" ? "Git access to origin" : "Repository checkout"} · ${target.repository.split(/[\\/]/u).at(-1) ?? ""}`;
  return {
    ssh: "SSH",
    platform: "Platform",
    artifact: "Remote daemon",
    folder: "Code folder",
    "command-line-tools": "Command Line Tools",
    power: "Stays awake",
  }[target.kind];
}
function Row({
  name,
  tone,
  text,
  action,
  target,
}: {
  name: ReactNode;
  tone: Tone;
  text: string;
  action?: ReactNode;
  target?: HostCheckTarget;
}) {
  const reload = use(ReloadContext);
  const pending = !!target && reload?.pending.has(rowKey(target));
  const failed = !!target && reload?.failed.has(rowKey(target));
  return (
    <div className="host-check-row" aria-busy={pending}>
      <span className="host-check-name">{name}</span>
      <Status tone={pending ? "work" : failed ? "fail" : tone}>
        {pending
          ? "Checking…"
          : failed
            ? reload?.saveFailed.has(rowKey(target))
              ? "Unable to save"
              : reload?.needsFullCheck
                ? "Check capabilities required"
                : "Unable to check"
            : text}
      </Status>
      <span className="host-check-action">
        {typeof action === "string" ? <span>{action}</span> : action}
        {target && reload && (
          <button
            type="button"
            className="host-row-reload"
            aria-label={`Reload ${reloadName(target)}`}
            title={`Reload ${reloadName(target)}`}
            disabled={pending}
            onClick={() => {
              reload.reload(target);
            }}
          >
            <span aria-hidden="true">↻</span>
          </button>
        )}
      </span>
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
  if (result.checkout.state === "absent") return { tone: "neutral", text: "Not checked out" };
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
  const ready =
    checks.every((check) => check?.state === "pass") &&
    facts.tools?.some((tool) => tool.id === "git" && tool.state === "ready") &&
    facts.requirements?.mac?.commandLineTools !== false &&
    facts.agents.some((agent) => agent.state === "ready");
  if (!ready) return "Needs you";
  const count = preflight.repositories.filter(
    (repo) =>
      repo.checkout.ok && repo.checkout.checkout && repo.checkout.checkout.state !== "absent",
  ).length;
  return `Ready · ${String(count)} ${count === 1 ? "repository" : "repositories"}`;
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
  cloning,
  disabled,
  act,
  changeFolder,
}: {
  entry: HostRow;
  preflight: HostPreflight | undefined;
  checking: boolean;
  progress: HostCheckProgress | undefined;
  cloning: string | undefined;
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
    if (folder?.state !== "fail") folderStatus.tone = "neutral";
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
            target={{ kind: "tool", tool: agent.id }}
            name={agentNames.get(agent.id) ?? agent.id}
            tone={
              needsCLT || (agent.id === "git" && agent.state === "missing")
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
              target={{ kind: "sign-in", tool: agent.id }}
              name={
                <>
                  {agentNames.get(agent.id) ?? agent.id} sign-in{" "}
                  {agent.id === "gh" && <span className="host-tag">PRs</span>}
                </>
              }
              tone={agent.signIn === "signed-in" ? "pass" : "neutral"}
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
  const readyRepositories = repositories.filter(
    (repo) =>
      repo.origin?.state === "pass" &&
      repo.checkout?.ok &&
      repo.checkout.checkout &&
      repo.checkout.checkout.state !== "absent",
  );
  const [showReady, setShowReady] = useState(false);
  return (
    <div className="host-checks" aria-busy={checking}>
      <Group>Host</Group>
      <Row
        target={{ kind: "ssh" }}
        name="SSH"
        {...checkPresentation(connection?.ssh, "Host key trusted")}
      />
      <Row
        target={{ kind: "platform" }}
        name="Platform"
        {...checkPresentation(connection?.platform, "Supported")}
      />
      <Row
        target={{ kind: "artifact" }}
        name="Remote daemon"
        {...checkPresentation(connection?.artifact, "In this build")}
      />
      <Row
        target={{ kind: "folder" }}
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
          target={{ kind: "command-line-tools" }}
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
      {repositories.length > 0 && (
        <button
          type="button"
          className="host-repositories"
          aria-expanded={showReady}
          onClick={() => {
            setShowReady(!showReady);
          }}
        >
          <span aria-hidden="true">{showReady ? "⌄" : "›"}</span> Repositories ·{" "}
          {readyRepositories.length} ready
        </button>
      )}
      {repositories
        .filter((repo) => showReady || !readyRepositories.includes(repo))
        .map((repo) => (
          <Fragment key={repo.repository}>
            <Group>Repository · {repo.repository.split(/[\\/]/u).at(-1)}</Group>
            <Row
              target={{ kind: "origin", repository: repo.repository }}
              name="Git access to origin"
              {...(checking && !repo.origin
                ? { tone: "work" as const, text: "Checking…" }
                : checkPresentation(repo.origin, "Reachable"))}
              action={
                repo.origin?.state === "fail" && repo.origin.reason === "origin-host-key" ? (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      act({
                        action: "trust-origin",
                        host: entry.host,
                        repository: repo.repository,
                      });
                    }}
                  >
                    Trust host key
                  </button>
                ) : undefined
              }
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
              target={{ kind: "checkout", repository: repo.repository }}
              name="Repository checkout"
              {...(cloning === repo.repository
                ? { tone: "work" as const, text: "Cloning…" }
                : checking && !repo.checkout
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
            target={{ kind: "power" }}
            name="Stays awake"
            tone={mac.staysAwake ? "pass" : "neutral"}
            text={mac.staysAwake ? "Pass · Stays awake" : "Warning · Sleeps when idle"}
            action={!mac.staysAwake ? "On the Mac · Battery → Options" : undefined}
          />
        </>
      )}
    </div>
  );
}
function HostName({
  entry,
  hosts,
  save,
}: {
  entry: HostRow;
  hosts: readonly HostRow[];
  save: (nickname: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const error = hostNicknameError(hosts, entry.host, name);
  if (!editing)
    return (
      <h3>
        <button
          type="button"
          className="host-name"
          aria-label={`Rename ${hostDisplayName(entry)}`}
          onClick={() => {
            setName(entry.nickname ?? "");
            setFailure("");
            setEditing(true);
          }}
        >
          {hostDisplayName(entry)}
          <svg
            className="host-name-pencil"
            viewBox="0 0 16 16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
          >
            <path d="m10.5 2.5 3 3-8 8-4 1 1-4zM9 4l3 3" />
          </svg>
        </button>
      </h3>
    );
  return (
    <form
      className="host-name-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (error || saving) return;
        setSaving(true);
        void save(name)
          .then(
            () => {
              setEditing(false);
            },
            () => {
              setFailure("Unable to rename host");
            },
          )
          .finally(() => {
            setSaving(false);
          });
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) {
          event.preventDefault();
          event.stopPropagation();
          setEditing(false);
        }
      }}
    >
      <input
        ref={(element) => {
          element?.focus();
        }}
        aria-label="Host nickname"
        placeholder={hostDisplayName({ host: entry.host })}
        value={name}
        disabled={saving}
        aria-invalid={!!error || !!failure}
        onChange={(event) => {
          setName(event.target.value);
          setFailure("");
        }}
      />
      <button type="submit" disabled={!!error || saving}>
        Save name
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setEditing(false);
        }}
      >
        Cancel
      </button>
      {(error || failure) && (
        <span role="alert" className="hosts-failure">
          {error || failure}
        </span>
      )}
    </form>
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
  const [nickname, setNickname] = useState("");
  const nicknameError = hostNicknameError(state.hosts, host.trim(), nickname);
  const renamedRef = useRef(new Map<string, { nickname: string }>());
  const [changing, setChanging] = useState<{ host: string; folder: string }>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [addBusy, setAddBusy] = useState(false);
  const [cloning, setCloning] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [error, setError] = useState("");
  const api = source.hosts;
  const [checkingHosts, setCheckingHosts] = useState<ReadonlySet<string>>(() => new Set());
  const [progress, setProgress] = useState<HostCheckProgress>();
  const changedRef = useRef(false);
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const applyState = (next: HostsState, host: string, startedRename?: { nickname: string }) => {
    setState((previous) => ({
      ...next,
      hosts: [
        ...previous.hosts.filter((entry) => entry.host !== host),
        ...next.hosts
          .filter((entry) => entry.host === host)
          .map((entry) => {
            const rename = renamedRef.current.get(entry.host);
            if (rename === undefined || rename === startedRename) return entry;
            const registration = { ...entry };
            delete registration.nickname;
            return rename.nickname ? { ...registration, nickname: rename.nickname } : registration;
          }),
      ].sort((a, b) => {
        const order = [...previous.hosts.map((entry) => entry.host), host];
        return order.indexOf(a.host) - order.indexOf(b.host);
      }),
      locations: [
        ...previous.locations.filter((entry) => entry.host !== host),
        ...next.locations.filter((entry) => entry.host === host),
      ],
    }));
  };
  useEffect(() => {
    if (!checkingHosts.size || !api) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api({ action: "progress" });
        if (active) setProgress(next.progress);
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
  }, [api, checkingHosts]);
  const runCheck = useCallback(
    async (host: string, codeFolder: string) => {
      setCheckingHosts((previous) => new Set(previous).add(host));
      try {
        return await api?.({ action: "preflight", host, codeFolder });
      } finally {
        setCheckingHosts((previous) => {
          const next = new Set(previous);
          next.delete(host);
          return next;
        });
        setProgress((previous) => (previous?.host === host ? undefined : previous));
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
        setState((previous) =>
          changedRef.current
            ? {
                ...previous,
                hosts: [
                  ...previous.hosts,
                  ...initial.hosts.filter(
                    (entry) => !previous.hosts.some((saved) => saved.host === entry.host),
                  ),
                ],
              }
            : initial,
        );
      } catch {
        if (current()) setError("Unable to load hosts");
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);
  const act = async (action: HostsAction) => {
    changedRef.current = true;
    if ("host" in action) setExpanded((previous) => new Map(previous).set(action.host, true));
    const target = "host" in action ? action.host : "";
    const startedRename = renamedRef.current.get(target);
    setBusy((previous) => new Set(previous).add(target));
    let enrolling = action.action === "add";
    if (enrolling) setAddBusy(true);
    if (action.action === "clone")
      setCloning((previous) => new Map(previous).set(action.host, action.repository));
    setError("");
    try {
      let next =
        action.action === "preflight"
          ? await runCheck(action.host, action.codeFolder)
          : await api?.(action);
      if (enrolling) {
        setAddBusy(false);
        enrolling = false;
      }
      if (!next) return;
      if ("host" in action && ["preflight", "add", "remove"].includes(action.action))
        setRowFailed(
          (previous) => new Set([...previous].filter((key) => !key.startsWith(`${action.host}:`))),
        );
      applyState(next, target, startedRename);
      if (action.action === "preflight" && next.preflight) {
        const preflight = next.preflight;
        setChecks((previous) => new Map(previous).set(action.host, preflight));
      }
      if (next.recipeFailure) setError("Recipe unavailable for this host");
      if (action.action === "add" && next.hosts.some((entry) => entry.host === action.host)) {
        setAdding(false);
        setHost("");
        setFolder("~/foom");
        setNickname("");
      } else if (action.action === "add" && next.result && !next.result.ok)
        setError(reasons[next.result.reason]);
      if (action.action === "change-folder") setChanging(undefined);
      if (
        (action.action === "change-folder" || action.action === "create-folder") &&
        next.result &&
        !next.result.ok
      )
        setError(reasons[next.result.reason]);
      if (action.action !== "preflight" && "host" in action) {
        const observed =
          next.preflight ??
          next.hosts.find((entry) => entry.host === action.host)?.observation?.preflight;
        setChecks((previous) => {
          const updated = new Map(previous);
          if (observed) updated.set(action.host, observed);
          else updated.delete(action.host);
          return updated;
        });
      }
      if (action.action === "clone") {
        const checkout = next.locations.find(
          (location) => location.host === action.host && location.repository === action.repository,
        )?.result;
        if (checkout)
          setChecks((previous) => {
            const observed =
              previous.get(action.host) ??
              state.hosts.find((entry) => entry.host === action.host)?.observation?.preflight;
            if (!observed) return previous;
            return new Map(previous).set(action.host, {
              ...observed,
              repositories: observed.repositories.map((repo) =>
                repo.repository === action.repository ? { ...repo, checkout } : repo,
              ),
            });
          });
      }
      if (action.action === "add") {
        const entry = next.hosts.find((entry) => entry.host === action.host);
        if (entry) {
          next = await runCheck(entry.host, entry.codeFolder);
          if (next) {
            applyState(next, target, startedRename);
            if (next.preflight) {
              const preflight = next.preflight;
              setChecks((previous) => new Map(previous).set(entry.host, preflight));
            }
          }
        }
      }
    } catch {
      setError("Unable to update hosts");
    } finally {
      setCloning((previous) => {
        const next = new Map(previous);
        next.delete(target);
        return next;
      });
      setBusy((previous) => {
        const next = new Set(previous);
        next.delete(target);
        return next;
      });
      if (enrolling) setAddBusy(false);
    }
  };
  const [rowFailed, setRowFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [rowPending, setRowPending] = useState<ReadonlySet<string>>(() => new Set());
  const reload = async (host: string, target: HostCheckTarget) => {
    const key = `${host}:${rowKey(target)}`;
    setExpanded((previous) => new Map(previous).set(host, true));
    setError("");
    setRowPending((previous) => new Set(previous).add(key));
    setRowFailed((previous) => {
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
    try {
      const next = await api?.({ action: "reload", host, target });
      if (next) {
        applyState(next, host);
        if (next.preflight) {
          const preflight = next.preflight;
          setChecks((previous) => new Map(previous).set(host, preflight));
        }
      }
    } catch {
      setRowFailed((previous) => new Set(previous).add(key));
    } finally {
      setRowPending((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
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
            disabled={addBusy}
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
            if (nicknameError || addBusy) return;
            void act({
              action: "add",
              host: host.trim(),
              codeFolder: folder,
              ...(nickname ? { nickname } : {}),
            });
          }}
        >
          <h3>Add host</h3>
          <fieldset disabled={addBusy} className="host-add-fields">
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
              Nickname (optional)
              <input
                value={nickname}
                aria-invalid={!!nicknameError}
                onChange={(event) => {
                  setNickname(event.target.value);
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
            <button type="submit" disabled={!host.trim() || !!nicknameError}>
              Add host
            </button>
            {nicknameError && (
              <span role="alert" className="hosts-failure host-notice">
                {nicknameError}
              </span>
            )}
            <span className="host-notice">Host key trusted outside Foom</span>
          </fieldset>
          <button
            className="host-cancel"
            type="button"
            disabled={addBusy}
            onClick={() => {
              setAdding(false);
            }}
          >
            Cancel
          </button>
          {addBusy && <p role="status">Checking…</p>}
        </form>
      )}
      {!state.hosts.length && !adding && <p>No hosts</p>}
      {state.hosts.map((entry) => {
        const preflight = checks.get(entry.host) ?? entry.observation?.preflight;
        const summary = hostSummary(preflight);
        const distro = entry.result?.ok ? entry.result.facts.requirements?.distro : undefined;
        const os = distro === "darwin" ? "macOS" : distro;
        const open =
          expanded.get(entry.host) ??
          (summary === "Needs you" ||
            preflight?.repositories.some(
              (repo) => repo.origin.state === "fail" || !repo.checkout.ok,
            ) === true);
        return (
          <section className="host-card host-compact" key={entry.host} aria-label={entry.host}>
            <div className="host-summary-row">
              <button
                type="button"
                className="host-expand"
                aria-expanded={open}
                aria-label={`${open ? "Collapse" : "Expand"} ${hostDisplayName(entry)}`}
                onClick={() => {
                  setExpanded((previous) => new Map(previous).set(entry.host, !open));
                }}
              >
                <span aria-hidden="true">{open ? "⌄" : "›"}</span>
                {!open && (
                  <>
                    <span>{hostDisplayName(entry)}</span>
                    <span className="host-count">{os}</span>
                  </>
                )}
              </button>
              {open && (
                <div className="host-title">
                  <HostName
                    entry={entry}
                    hosts={state.hosts}
                    save={async (nickname) => {
                      const next = await api?.({ action: "rename", host: entry.host, nickname });
                      if (!next) throw new Error("Rename unavailable");
                      const rename = { nickname };
                      renamedRef.current.set(entry.host, rename);
                      applyState(next, entry.host, rename);
                    }}
                  />
                  <span className="host-count">{os}</span>
                </div>
              )}
              <span className={`host-count ${summary === "Needs you" ? "host-need" : ""}`}>
                {busy.has(entry.host) ? (
                  <span className="host-check-progress host-work" role="status">
                    <span className="host-throbber" aria-hidden="true" />
                    {hostProgressText(progress?.host === entry.host ? progress : undefined)}
                  </span>
                ) : (
                  summary
                )}
              </span>
            </div>
            <fieldset className="host-body" hidden={!open} disabled={busy.has(entry.host)}>
              <div className="host-meta">
                <CopyValue
                  value={entry.host}
                  label="Copy host alias"
                  copy={() =>
                    source.copyHost?.({ kind: "copy-host-alias", host: entry.host }) ??
                    Promise.reject(new Error("Copy unavailable"))
                  }
                />
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
                <button
                  type="button"
                  className="host-remove"
                  disabled={busy.has(entry.host)}
                  onClick={() => {
                    void act({ action: "remove", host: entry.host });
                  }}
                >
                  Remove
                </button>
              </div>
              <ReloadContext
                value={{
                  reload: (target) => {
                    void reload(entry.host, target);
                  },
                  needsFullCheck: (preflight?.result ?? entry.result)?.ok !== true,
                  saveFailed: new Set(
                    (entry.rowFailures ?? [])
                      .filter((row) => row.reason === "save-failed")
                      .map((row) => rowKey(row.target)),
                  ),
                  failed: new Set([
                    ...[...rowFailed]
                      .filter((key) => key.startsWith(`${entry.host}:`))
                      .map((key) => key.slice(entry.host.length + 1)),
                    ...(entry.rowFailures ?? []).map((row) => rowKey(row.target)),
                  ]),
                  pending: new Set(
                    [...rowPending]
                      .filter((key) => key.startsWith(`${entry.host}:`))
                      .map((key) => key.slice(entry.host.length + 1)),
                  ),
                }}
              >
                <Checklist
                  entry={entry}
                  preflight={preflight}
                  progress={progress?.host === entry.host ? progress : undefined}
                  checking={checkingHosts.has(entry.host)}
                  cloning={cloning.get(entry.host)}
                  disabled={busy.has(entry.host)}
                  act={(action) => {
                    void act(action);
                  }}
                  changeFolder={() => {
                    setChanging({ host: entry.host, folder: entry.codeFolder });
                  }}
                />
              </ReloadContext>
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
                  <button type="submit" disabled={busy.has(entry.host) || !changing.folder.trim()}>
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
                  {entry.observation ? (
                    <>
                      Last checked{" "}
                      <time dateTime={new Date(entry.observation.checkedAt).toISOString()}>
                        {new Date(entry.observation.checkedAt).toLocaleString()}
                      </time>
                    </>
                  ) : (
                    "Not checked"
                  )}
                </span>
                <button
                  type="button"
                  disabled={busy.has(entry.host)}
                  onClick={() => {
                    void act({
                      action: "preflight",
                      host: entry.host,
                      codeFolder: entry.codeFolder,
                    });
                  }}
                >
                  Check capabilities
                </button>
              </footer>
              <details className="host-details">
                <summary>Host facts</summary>
                <button
                  type="button"
                  disabled={busy.has(entry.host)}
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
                        disabled={busy.has(entry.host)}
                        onClick={() => {
                          void act({ action: "end", host: entry.host });
                        }}
                      >
                        End…
                      </button>
                    )}
                  </p>
                )}
                {entry.result && !entry.result.ok && preflight?.result.ok && (
                  <p role="status">
                    <Status tone="fail">{reasons[entry.result.reason]}</Status>
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
            </fieldset>
          </section>
        );
      })}
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
  const [cloning, setCloning] = useState<{ host: string; repository: string }>();
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
    if (action.action === "clone") setCloning(action);
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
      setCloning(undefined);
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
            <h3>{host.host === null ? "Local" : hostDisplayName(host)}</h3>
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
            const isCloning = cloning?.host === host.host && cloning.repository === repo.path;
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
                    : { tone: isCloning ? ("work" as const) : checkoutPresentation(result).tone })}
                >
                  {host.host === null
                    ? "Checked out"
                    : isCloning
                      ? "Cloning…"
                      : checkoutPresentation(result).text}
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
