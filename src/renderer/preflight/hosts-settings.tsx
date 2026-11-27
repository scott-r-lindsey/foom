import { RepositoryRequirementsCards } from "./repository-requirements";
import { GithubSignInPanel } from "./github-sign-in";
import { useHostsView, useViewState } from "../data/view-hooks";
import { HostTerminal } from "./host-terminal";
import { HostSetupDialog } from "./host-setup-dialog";
import {
  hostDisplayName,
  completedHostCheck,
  hostKeyUntrusted,
  hostNicknameError,
  sameGitOriginEndpoint,
} from "../../shared/registered-hosts";
import { Fragment, createContext, use, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { CopyValue } from "../ui/copy-value";
import type {
  HostCheckTarget,
  GitOriginEndpoint,
  HostCheck,
  HostCheckProgress,
  HostFailure,
  HostPreflight,
  HostRow,
  HostsAction,
  HostsState,
} from "../../shared/registered-hosts.d";
import type { SetupSource } from "./setup-source.d";
import type { Repository } from "../../shared/worktrees";
import type { AgentInstallation } from "../../shared/agents";

type RegisteredGitOrigin = NonNullable<HostsState["gitOrigins"]>[number];
type RecipeView = {
  host: string;
  id: string;
  phase: "running" | "checking" | "finished";
  installTool?: string;
  endpoint?: GitOriginEndpoint;
  reveal?: true;
  gh?: "install" | "sign-in";
};
const originRecipeKey = (host: string, endpoint: GitOriginEndpoint) =>
  JSON.stringify([host, endpoint.host, endpoint.port, endpoint.protocol]);
const EMPTY_HOSTS: HostsState = { hosts: [], locations: [] };
const reasons: Record<HostFailure, string> = {
  unreachable: "Host unreachable",
  "host-key-unknown": "Host key not trusted",
  "host-key-changed": "Host key changed",
  "login-rejected": "Login rejected",
  "version-mismatch": "Host version mismatch",
  "provider-invalid": "Agent configuration unavailable",
  "configuration-changed": "Agent configuration changed",
  "invalid-reply": "Invalid host reply",
  cancelled: "Host check cancelled",
  unsupported: "Unsupported host platform",
  "facts-unavailable": "Host daemon needs an update for host facts",
  "libc-too-old": "Unsupported · glibc < 2.28",
  "libc-unsupported": "Unsupported · musl libc",
  "artifact-unavailable": "Unavailable in this build",
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
function failureTone(reason: HostFailure): "need" | "fail" | "neutral" {
  return reason === "artifact-unavailable"
    ? "neutral"
    : reason === "host-key-unknown"
      ? "need"
      : "fail";
}
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
const sshRowKey = rowKey({ kind: "ssh" });
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
  reloadLabel,
}: {
  name: ReactNode;
  tone: Tone;
  text: ReactNode;
  action?: ReactNode;
  target?: HostCheckTarget;
  reloadLabel?: string;
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
            aria-label={`Reload ${reloadLabel ?? reloadName(target)}`}
            title={`Reload ${reloadLabel ?? reloadName(target)}`}
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
    return {
      tone: failureTone(check.reason),
      text: reasons[check.reason],
    };
  return { tone: "neutral", text: "Not checked" };
}
export function hostProgressText(progress: HostCheckProgress | undefined): string {
  if (!progress || progress.phase === "inspect") return "Checking host…";
  const index = progress.repositories.findIndex((repo) => repo.repository === progress.repository);
  const name = progress.repository?.split(/[\\/]/u).at(-1) ?? "";
  const step = progress.phase === "origin" ? "Checking Git access" : "Checking checkout";
  return `${step} · ${name} (${String(index + 1)} of ${String(progress.repositories.length)})`;
}
function buildPreflight(
  preflight: HostPreflight | undefined,
  available: boolean | undefined,
): HostPreflight | undefined {
  if (available !== false) return preflight;
  return {
    ssh: preflight?.ssh ?? { state: "not-checked" },
    platform: preflight?.platform ?? { state: "not-checked" },
    artifact: { state: "fail", reason: "artifact-unavailable" },
    result: { ok: false, reason: "artifact-unavailable" },
    repositories:
      preflight?.repositories.map((repo) => ({
        ...repo,
        origin: { state: "not-checked" },
        checkout: { ok: false, reason: "artifact-unavailable" },
      })) ?? [],
  };
}
function hostSummary(preflight: HostPreflight | undefined) {
  if (!preflight) return "Not checked";
  const result = preflight.result;
  if (preflight.ssh.state === "fail") return "Needs you";
  if (!result.ok)
    return result.reason === "artifact-unavailable" ? "Unavailable in this build" : "Needs you";
  const facts = result.facts;
  const checks = [preflight.ssh, preflight.platform, preflight.artifact, facts.folder];
  if (checks.some((check) => check?.state === "fail")) return "Needs you";
  if (facts.tools === undefined && facts.agents.length === 0) return "Not checked";
  const ready =
    checks.every((check) => check?.state === "pass") &&
    facts.tools?.some((tool) => tool.id === "git" && tool.state === "ready") &&
    facts.requirements?.mac?.commandLineTools !== false &&
    facts.agents.some((agent) => agent.state === "ready");
  if (!ready) return "Needs you";
  return "Ready";
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
function gitProtocolStatus(
  protocol: "ssh" | "https",
  checks: readonly (HostCheck | undefined)[],
  checking: boolean,
): { tone: Tone; text: string } {
  const label = protocol === "ssh" ? "SSH" : "HTTPS";
  const failed = checks.find((check) => check?.state === "fail");
  if (failed) {
    const reason =
      failed.reason === "origin-auth"
        ? protocol === "ssh"
          ? "key not accepted"
          : "authentication failed"
        : reasons[failed.reason];
    return { tone: "fail", text: `${label} · ${reason}` };
  }
  if (checking && checks.includes(undefined)) return { tone: "work", text: `${label} · Checking…` };
  if (checks.some((check) => check?.state === "pass")) return { tone: "pass", text: `${label} ✓` };
  return { tone: "neutral", text: `${label} · Not checked` };
}
function GitAccess({
  origins,
  repositories,
  checking,
  factsAvailable,
  host,
  disabled,
  originTerminals,
  act,
}: {
  origins: HostsState["gitOrigins"];
  repositories: HostCheckProgress["repositories"];
  checking: boolean;
  factsAvailable: boolean;
  host: string;
  disabled: boolean;
  originTerminals: ReadonlyMap<string, { running: boolean; panel: ReactNode }>;
  act: (action: HostsAction) => void;
}) {
  const checks = new Map(repositories.map((check) => [check.repository, check]));
  const checkFor = (origin: RegisteredGitOrigin) => {
    const check = checks.get(origin.repository);
    return factsAvailable && check && sameGitOriginEndpoint(check.originEndpoint, origin)
      ? check.origin
      : undefined;
  };
  const forges = new Map<string, Record<RegisteredGitOrigin["protocol"], RegisteredGitOrigin[]>>();
  for (const origin of origins ?? []) {
    const protocols = forges.get(origin.host) ?? { ssh: [], https: [] };
    protocols[origin.protocol].push(origin);
    forges.set(origin.host, protocols);
  }
  if (!forges.size) return null;
  return (
    <>
      <Group>Git access</Group>
      {[...forges].map(([hostname, protocols]) => {
        const statuses = (["ssh", "https"] as const).flatMap((protocol) => {
          const endpoints = protocols[protocol];
          return endpoints.length
            ? [{ protocol, ...gitProtocolStatus(protocol, endpoints.map(checkFor), checking) }]
            : [];
        });
        const tone: Tone = statuses.some((status) => status.tone === "fail")
          ? "fail"
          : statuses.some((status) => status.tone === "work")
            ? "work"
            : statuses.every((status) => status.tone === "pass")
              ? "pass"
              : "neutral";
        const untrusted = new Map<GitOriginEndpoint["port"], RegisteredGitOrigin>();
        for (const origin of protocols.ssh) {
          const check = checkFor(origin);
          if (
            check?.state === "fail" &&
            check.reason === "origin-host-key" &&
            !untrusted.has(origin.port)
          )
            untrusted.set(origin.port, origin);
        }
        const showPort = new Set(protocols.ssh.map(({ port }) => port)).size > 1;
        const endpoints = [...protocols.ssh, ...protocols.https];
        const repository = endpoints[0]?.repository;
        const name =
          hostname === "github.com" ? "GitHub" : hostname === "gitlab.com" ? "GitLab" : hostname;
        return (
          <Row
            key={hostname}
            name={name}
            tone={tone}
            text={
              <span className="host-git-protocols">
                {statuses.map((status) => (
                  <span key={status.protocol} className={`host-${status.tone}`}>
                    {status.text}
                  </span>
                ))}
              </span>
            }
            {...(endpoints.length === 1 && repository && checks.has(repository)
              ? {
                  target: { kind: "origin" as const, repository },
                  reloadLabel: `${name} Git access`,
                }
              : {})}
            action={[...untrusted].map(([port, origin]) => (
              <button
                key={port ?? "ssh-config"}
                type="button"
                disabled={disabled || originTerminals.get(originRecipeKey(host, origin))?.running}
                aria-label={
                  showPort
                    ? port === null
                      ? `Trust host key for ${hostname} using SSH config…`
                      : `Trust host key for ${hostname}:${String(port)}…`
                    : undefined
                }
                onClick={() => {
                  act({
                    action: "trust-origin",
                    host,
                    repository: origin.repository,
                    endpoint: {
                      host: origin.host,
                      protocol: origin.protocol,
                      port,
                    },
                  });
                }}
              >
                {showPort
                  ? port === null
                    ? "Trust (SSH config)…"
                    : `Trust :${String(port)}…`
                  : "Trust host key…"}
              </button>
            ))}
          />
        );
      })}
    </>
  );
}

function Checklist({
  awaitingTrust,
  ssh,
  entry,
  preflight,
  checking,
  progress,
  disabled,
  act,
  changeFolder,
  openAgents,
  enabledAgents,
  ghPanel,
  ghRunning,
  originTerminals,
  gitOrigins,
  signInTerminal,
  copySsh,
}: {
  ghPanel?: ReactNode;
  gitOrigins: HostsState["gitOrigins"];
  originTerminals: ReadonlyMap<string, { running: boolean; panel: ReactNode }>;
  signInTerminal?: { tool: string; running: boolean; panel: ReactNode } | undefined;
  ghRunning?: boolean;
  awaitingTrust: boolean;
  ssh: HostCheck | undefined;
  copySsh: () => Promise<unknown>;
  openAgents?: ((host: string) => void) | undefined;
  enabledAgents?: Readonly<Record<string, boolean>> | undefined;
  entry: HostRow;
  preflight: HostPreflight | undefined;
  checking: boolean;
  progress: HostCheckProgress | undefined;
  disabled: boolean;
  act: (action: HostsAction) => void;
  changeFolder: () => void;
}) {
  const reload = use(ReloadContext);
  const result = progress?.result ?? preflight?.result ?? entry.result;
  const facts = result?.ok ? result.facts : undefined;
  const agents =
    facts && (facts.tools !== undefined || facts.agents.length > 0) ? facts.agents : undefined;
  const mac = facts?.requirements?.mac;
  const connection = progress?.result
    ? progress.result.connection
    : (preflight ?? result?.connection);
  const unmatchedFailure =
    result &&
    !result.ok &&
    !(result.reason === "unreachable" && ssh?.state === "fail") &&
    ![ssh, connection?.platform, connection?.artifact].some(
      (check) => check?.state === "fail" && check.reason === result.reason,
    )
      ? result.reason
      : undefined;
  const folderFailure =
    unmatchedFailure === "folder-missing" ||
    unmatchedFailure === "folder-refused" ||
    unmatchedFailure === "unsafe-folder";
  const folder = folderFailure
    ? { state: "fail" as const, reason: unmatchedFailure }
    : facts?.folder;
  const sshStatus = checkPresentation(ssh, "Host key trusted");
  const trustFailure =
    entry.hostKeyTrustFailure && "Unable to trust host key · " + entry.hostKeyTrustFailure;
  const daemon =
    unmatchedFailure && !folderFailure
      ? { state: "fail" as const, reason: unmatchedFailure }
      : connection?.artifact;
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
      disabled={
        disabled ||
        (operation === "install" && reload?.pending.has(rowKey({ kind: "tool", tool: id }))) ||
        (id === "gh" && ghRunning) ||
        (signInTerminal?.tool === id && signInTerminal.running)
      }
      aria-label={`${operation === "install" ? (id === "gh" ? "Install & sign in" : "Install") : "Sign in"} ${id}`}
      onClick={() => {
        act({
          action: "recipe",
          host: entry.host,
          tool: id,
          operation: id === "gh" && operation === "install" ? "install-sign-in" : operation,
        });
      }}
    >
      {operation === "install" ? (id === "gh" ? "Install & sign in" : "Install") : "Sign in"}
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
            name={agent.id === "gh" ? "GitHub CLI" : (agentNames.get(agent.id) ?? agent.id)}
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
          {agent.id === "gh" && agent.state === "missing" && ghPanel}
          {agent.id !== "git" && agent.state === "ready" && !(agent.id === "gh" && ghPanel) && (
            <Row
              target={{ kind: "sign-in", tool: agent.id }}
              name={
                <>
                  {agent.id === "gh" ? "GitHub CLI" : (agentNames.get(agent.id) ?? agent.id)}{" "}
                  sign-in {agent.id === "gh" && <span className="host-tag">PRs</span>}
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
          {agent.id === "gh" && agent.state === "ready" && ghPanel}
          {signInTerminal?.tool === agent.id && signInTerminal.panel}
          {agent.id === "gh" && agent.signIn !== "signed-in" && (
            <p className="github-token-note">
              Without a keyring, gh may store your token in plain text on this host.
            </p>
          )}
        </Fragment>
      );
    });
  return (
    <div className="host-checks" aria-busy={checking}>
      <fieldset className="host-controls" disabled={disabled}>
        <Group>Host</Group>
        <Row
          target={{ kind: "ssh" }}
          name="SSH"
          tone={sshStatus.tone}
          text={
            trustFailure ? (
              <>
                <span>{sshStatus.text}</span>
                <br />
                <span className="host-fail">{trustFailure}</span>
              </>
            ) : (
              sshStatus.text
            )
          }
          action={
            ssh?.state === "fail" && ssh.reason === "host-key-unknown" ? (
              entry.hostKeyTrust === "askpass" ? (
                <button
                  className="primary"
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    act({ action: "trust-host-key", host: entry.host });
                  }}
                >
                  Trust host key…
                </button>
              ) : (
                <CopyValue value={`ssh ${entry.host}`} label="Copy SSH command" copy={copySsh} />
              )
            ) : undefined
          }
        />
        {!awaitingTrust && (
          <>
            <Row
              target={{ kind: "platform" }}
              name="Platform"
              {...checkPresentation(connection?.platform, "Supported")}
            />
            <Row
              target={{ kind: "artifact" }}
              name="Remote daemon"
              {...checkPresentation(daemon, "In this build")}
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
            {openAgents && agents ? (
              <Row
                name="Agents"
                tone="neutral"
                text={`${String(agents.filter((agent) => enabledAgents?.[agent.id] === true && agent.state === "ready" && agent.signIn !== "signed-out").length)} of ${String(Object.values(enabledAgents ?? {}).filter((enabled) => enabled).length)} ready`}
                action={
                  <button
                    type="button"
                    onClick={() => {
                      openAgents(entry.host);
                    }}
                  >
                    Open
                  </button>
                }
              />
            ) : agents ? (
              tools(agents)
            ) : (
              <Row name="Agents" tone="neutral" text="Not checked" />
            )}
          </>
        )}
        {!awaitingTrust && (
          <GitAccess
            origins={gitOrigins}
            repositories={progress?.repositories ?? preflight?.repositories ?? []}
            checking={checking}
            factsAvailable={!!facts}
            host={entry.host}
            disabled={disabled}
            originTerminals={originTerminals}
            act={act}
          />
        )}
      </fieldset>
      {[...originTerminals].map(([endpoint, terminal]) => (
        <Fragment key={endpoint}>{terminal.panel}</Fragment>
      ))}
      {!awaitingTrust && mac && (
        <fieldset className="host-controls" disabled={disabled}>
          <Group>Power</Group>
          <Row
            target={{ kind: "power" }}
            name="Stays awake"
            tone={mac.staysAwake ? "pass" : "neutral"}
            text={mac.staysAwake ? "Pass · Stays awake" : "Warning · Sleeps when idle"}
            action={!mac.staysAwake ? "On the Mac · Battery → Options" : undefined}
          />
        </fieldset>
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
  agents,
  defaultAgent = null,
  setupAgents,
  repositories = [],
  openAgents,
  source,
  headingRef,
}: {
  agents?: Readonly<Record<string, boolean>>;
  defaultAgent?: string | null;
  setupAgents?: readonly AgentInstallation[] | undefined;
  repositories?: readonly Repository[];
  openAgents?: (host: string) => void;
  source: Pick<
    SetupSource,
    | "hosts"
    | "copyHost"
    | "views"
    | "hostTerminal"
    | "installs"
    | "githubSignIn"
    | "githubSignInSessions"
  >;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const hostsQuery = useHostsView(
    source,
    () => source.hosts?.({ action: "list" }) ?? Promise.resolve(EMPTY_HOSTS),
  );
  const [state, setState] = useViewState(hostsQuery, EMPTY_HOSTS);
  const [setupHost, setSetupHost] = useState<string>();
  const setupEntry = state.hosts.find((entry) => entry.host === setupHost);
  const [checks, setChecks] = useState<ReadonlyMap<string, HostPreflight>>(
    () => new Map<string, HostPreflight>(),
  );
  const rememberChecklist = useCallback(
    (host: string, preflight: HostPreflight | undefined) => {
      if (source.views) return;
      setChecks((previous) => {
        const updated = new Map(previous);
        if (preflight) updated.set(host, preflight);
        else updated.delete(host);
        return updated;
      });
    },
    [source.views],
  );
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState("");
  const [folder, setFolder] = useState("~/foom");
  const [nickname, setNickname] = useState("");
  const nicknameError = hostNicknameError(state.hosts, host.trim(), nickname);
  const renamedRef = useRef(new Map<string, { nickname: string }>());
  const [changing, setChanging] = useState<{ host: string; folder: string }>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingFolderViews, setPendingFolderViews] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  if (pendingFolderViews.size) {
    // A coalesced snapshot may already reflect a subsequent edit or removal.
    const stillPending = new Map(
      [...pendingFolderViews].filter(([host, previousFolder]) =>
        state.hosts.some((entry) => entry.host === host && entry.codeFolder === previousFolder),
      ),
    );
    if (stillPending.size !== pendingFolderViews.size) setPendingFolderViews(stillPending);
  }
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<ReactNode>();
  const [error, setError] = useState<ReactNode>("");
  const api = source.hosts;
  const [resuming, setResuming] = useState(!!source.views);
  useEffect(() => {
    if (!source.views) return;
    let active = true;
    // Opening Hosts has always resumed owner-held row/save retries. A command
    // still owns that work; its unversioned reply never replaces the live view.
    void Promise.resolve(api?.({ action: "list" }))
      .catch(() => {
        if (active) setError("Unable to refresh hosts");
      })
      .finally(() => {
        if (active) setResuming(false);
      });
    return () => {
      active = false;
    };
  }, [api, source.views]);
  const [checkingHosts, setCheckingHosts] = useState<ReadonlySet<string>>(() => new Set());
  const [progress, setProgress] = useState<readonly HostCheckProgress[]>();
  const [rowPending, setRowPending] = useState<ReadonlySet<string>>(() => new Set());
  const [recipes, setRecipes] = useState<ReadonlyMap<string, RecipeView>>(() => {
    const saved = new Map<string, RecipeView>(
      [...(source.installs?.sessions() ?? [])].map(([host, id]) => [
        host,
        {
          host,
          id,
          phase: "running",
          ...(source.githubSignInSessions?.().has(id)
            ? {
                gh: source.githubSignInSessions().get(id)
                  ? ("install" as const)
                  : ("sign-in" as const),
              }
            : {}),
        },
      ]),
    );
    for (const [id, action] of source.installs?.hostActions?.() ?? []) {
      if (action.action === "trust-origin")
        saved.set(originRecipeKey(action.host, action.endpoint), {
          host: action.host,
          id,
          endpoint: action.endpoint,
          phase: "running",
        });
      else if (action.operation === "install") {
        const recipe = saved.get(action.host);
        if (recipe?.id === id) saved.set(action.host, { ...recipe, installTool: action.tool });
      }
    }
    return saved;
  });
  const clearRecipe = (host: string) => {
    setRecipes(
      (previous) =>
        new Map(
          [...previous].filter(([, recipe]) => recipe.host !== host || recipe.phase !== "finished"),
        ),
    );
  };
  const recipeFinished = useCallback(
    async (id: string, succeeded?: boolean) => {
      setRecipes((previous) => {
        for (const [key, recipe] of previous)
          if (recipe.id === id && recipe.installTool)
            return new Map(previous).set(key, { ...recipe, phase: "checking" });
        return previous;
      });
      await api?.({ action: "list" })
        .then((next) => {
          setState(next);
          setChecks(new Map());
        })
        .catch(() => {
          setError("Unable to refresh tool");
        });
      setRecipes((previous) => {
        for (const [key, recipe] of previous)
          if (recipe.id === id) return new Map(previous).set(key, { ...recipe, phase: "finished" });
        return previous;
      });
      if (succeeded)
        setRecipes((previous) => new Map([...previous].filter(([, recipe]) => recipe.id !== id)));
    },
    [api, setState],
  );
  const originPanel = (id: string, reveal = false) =>
    source.hostTerminal && (
      <HostTerminal
        key={id}
        id={id}
        source={source.hostTerminal}
        finished={recipeFinished}
        label="Origin host key terminal"
        activeLabel="Verify the fingerprint in SSH"
        collapseOnExit
        showExitStatus={false}
        reveal={reveal}
      />
    );
  const refreshGithubTool = useCallback(
    async (host: string) => {
      try {
        const next = await api?.({ action: "reload", host, target: { kind: "tool", tool: "gh" } });
        if (next) {
          setState(next);
          rememberChecklist(host, next.preflight);
        }
      } catch {
        setError("Unable to refresh tool");
      }
    },
    [api, rememberChecklist, setState],
  );
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
  const progressPendingRef = useRef(false);
  useEffect(() => {
    if ((!checkingHosts.size && !busy.size && !addBusy && !rowPending.size) || !api) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!progressPendingRef.current) {
        progressPendingRef.current = true;
        try {
          const next = await api({ action: "progress" });
          if (active) setProgress(next.progress);
        } catch {
          // The authoritative preflight request owns error reporting.
        }
        progressPendingRef.current = false;
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
  }, [api, checkingHosts, busy, addBusy, rowPending]);
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
        setProgress((previous) => previous?.filter((entry) => entry.host !== host));
      }
    },
    [api],
  );
  useEffect(
    () => () => {
      void Promise.resolve(api?.({ action: "cancel-trust" })).catch(() => undefined);
    },
    [api],
  );

  const act = async (action: HostsAction) => {
    changedRef.current = true;
    if ("host" in action && action.action !== "remove") {
      clearRecipe(action.host);
      setExpanded((previous) => new Map(previous).set(action.host, true));
    }
    const target = "host" in action ? action.host : "";
    const startedRename = renamedRef.current.get(target);
    setBusy((previous) => new Set(previous).add(target));
    let enrolling = action.action === "add";
    if (enrolling) {
      setAddBusy(true);
      setAddError(undefined);
    }
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
      if (action.action === "remove") {
        if (next.hosts.some((entry) => entry.host === action.host)) return;
        clearRecipe(action.host);
      }
      if (
        !next.preflightSaveFailed &&
        "host" in action &&
        ["preflight", "add", "remove"].includes(action.action)
      )
        setRowFailed(
          (previous) =>
            new Map([...previous].filter(([key]) => !key.startsWith(`${action.host}:`))),
        );
      applyState(next, target, startedRename);
      if (action.action === "preflight" && next.preflight) {
        const preflight = next.preflight;
        rememberChecklist(action.host, preflight);
        if (next.preflightSaveFailed && preflight.ssh.state !== "not-checked") {
          const key = `${action.host}:${sshRowKey}`;
          setRowFailed((previous) => {
            const updated = new Map(previous);
            updated.delete(key);
            return updated;
          });
        }
      }
      if (next.recipeSession && "host" in action) {
        const id = next.recipeSession;
        setRecipes((previous) =>
          new Map(previous).set(
            action.action === "trust-origin"
              ? originRecipeKey(action.host, action.endpoint)
              : action.host,
            {
              host: action.host,
              id,
              phase: "running",
              ...(action.action === "recipe" && action.operation === "install"
                ? { installTool: action.tool }
                : {}),
              ...(action.action === "trust-origin"
                ? { endpoint: action.endpoint, reveal: true as const }
                : {}),
              ...(action.action === "recipe" && action.tool === "gh"
                ? {
                    gh:
                      action.operation === "install-sign-in"
                        ? ("install" as const)
                        : ("sign-in" as const),
                  }
                : {}),
            },
          ),
        );
      }
      if (next.recipeFailure) setError("Recipe unavailable for this host");
      if (action.action === "add" && next.hosts.some((entry) => entry.host === action.host)) {
        setAdding(false);
        setHost("");
        setFolder("~/foom");
        setNickname("");
      } else if (action.action === "add" && next.result && !next.result.ok)
        setAddError(
          <Status tone={failureTone(next.result.reason)}>{reasons[next.result.reason]}</Status>,
        );
      if (action.action === "change-folder") {
        setChanging(undefined);
        if (source.views && next.result?.ok) {
          const previousFolder = state.hosts.find((entry) => entry.host === target)?.codeFolder;
          if (previousFolder !== undefined && previousFolder !== next.result.facts.codeFolder)
            setPendingFolderViews((previous) => new Map(previous).set(target, previousFolder));
        }
      }
      if (
        (action.action === "change-folder" || action.action === "create-folder") &&
        next.result &&
        !next.result.ok
      )
        setError(
          <Status tone={failureTone(next.result.reason)}>{reasons[next.result.reason]}</Status>,
        );
      // Refresh facts returns resource and inventory observations only.
      if (action.action !== "preflight" && action.action !== "refresh" && "host" in action) {
        const observed =
          next.preflight ??
          next.hosts.find((entry) => entry.host === action.host)?.observation?.preflight;
        rememberChecklist(action.host, observed);
      }
      if (action.action === "add") {
        const entry = next.hosts.find((entry) => entry.host === action.host);
        if (entry) {
          next = await runCheck(entry.host, entry.codeFolder);
          if (next) {
            applyState(next, target, startedRename);
            if (next.preflight) rememberChecklist(entry.host, next.preflight);
          }
        }
      }
      if (next?.preflightSaveFailed && !source.views) setError("Unable to update hosts");
    } catch {
      if (enrolling) setAddError("Unable to add host");
      else setError("Unable to update hosts");
    } finally {
      setBusy((previous) => {
        const next = new Set(previous);
        next.delete(target);
        return next;
      });
      if (enrolling) setAddBusy(false);
    }
  };
  const [rowFailed, setRowFailed] = useState<ReadonlyMap<string, number>>(() => new Map());
  const reload = async (host: string, target: HostCheckTarget, sshRevision: number) => {
    clearRecipe(host);
    const key = `${host}:${rowKey(target)}`;
    setExpanded((previous) => new Map(previous).set(host, true));
    setError("");
    setRowPending((previous) => new Set(previous).add(key));
    setRowFailed((previous) => {
      const next = new Map(previous);
      next.delete(key);
      return next;
    });
    try {
      const next = await api?.({ action: "reload", host, target });
      if (next) {
        applyState(next, host);
        if (next.preflight) rememberChecklist(host, next.preflight);
      }
    } catch {
      setRowFailed((previous) => new Map(previous).set(key, sshRevision));
    } finally {
      setRowPending((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    }
  };
  const hostError =
    error ||
    (state.hosts.some((entry) => entry.checklist?.saveFailed) ? "Unable to update hosts" : "");
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
              setAddError(undefined);
              setAdding(true);
            }}
          >
            Add host
          </button>
        )}
      </header>
      {state.remoteHostsAvailable === false && <p>This build has no remote host support</p>}
      {!!(hostError || hostsQuery.isError) && (
        <p role="alert" className={typeof hostError === "string" ? "hosts-failure" : undefined}>
          {hostError || "Unable to load hosts"}
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
                  setAddError(undefined);
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
                  setAddError(undefined);
                  setNickname(event.target.value);
                }}
              />
            </label>
            <label>
              Code folder
              <input
                value={folder}
                onChange={(event) => {
                  setAddError(undefined);
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
            {addBusy && (
              <span className="host-check-progress host-work host-notice" role="status">
                <span className="host-throbber" aria-hidden="true" />
                Checking host…
              </span>
            )}
            {addError && (
              <span className="host-notice" role="alert">
                {addError}
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
        </form>
      )}
      {!state.hosts.length && !adding && <p>No hosts</p>}
      {hostsQuery.data !== undefined &&
        [...recipes.values()].map((recipe) =>
          recipe.endpoint &&
          recipe.phase !== "finished" &&
          !state.hosts.some((host) => host.host === recipe.host) ? (
            <section
              className="host-card host-compact"
              key={recipe.id}
              aria-label={`Origin trust · ${recipe.host}`}
            >
              <header className="hosts-heading">
                <h3>{recipe.host} · Removed</h3>
              </header>
              {originPanel(recipe.id)}
            </section>
          ) : null,
        )}
      {state.hosts.map((entry) => {
        const recipe = recipes.get(entry.host);
        const recipeAction = recipe && source.installs?.hostActions?.().get(recipe.id);
        const originTerminals = new Map<string, { running: boolean; panel: ReactNode }>();
        const terminal =
          recipe &&
          !recipe.gh &&
          !(recipeAction?.action === "recipe" && recipeAction.operation === "install-plugin") &&
          source.hostTerminal ? (
            <HostTerminal
              key={recipe.id}
              id={recipe.id}
              source={source.hostTerminal}
              finished={recipeFinished}
              {...(recipeAction?.action === "recipe" && recipeAction.operation === "sign-in"
                ? {
                    label: "Agent sign-in terminal",
                    activeLabel: "Signing in…",
                    collapseOnExit: true,
                  }
                : {})}
            />
          ) : undefined;
        const latest = completedHostCheck(entry, entry.checklist, checks.get(entry.host));
        const sshRevision = latest?.sshRevision ?? 0;
        const preflight = buildPreflight(latest, state.remoteHostsAvailable);
        const hostProgress = progress?.find((item) => item.host === entry.host);
        const checkouts = (hostProgress?.repositories ?? preflight?.repositories ?? []).flatMap(
          ({ repository, checkout: result }) =>
            result?.ok && result.checkout && result.checkout.state !== "absent"
              ? [{ repository, path: result.checkout.path }]
              : [],
        );
        const ssh = preflight?.ssh ?? (source.views ? undefined : entry.result?.connection?.ssh);
        const awaitingTrust = ssh?.state === "fail" && ssh.reason === "host-key-unknown";
        const untrusted = hostKeyUntrusted(ssh);
        const controlsDisabled =
          resuming || busy.has(entry.host) || pendingFolderViews.has(entry.host);
        if (source.hostTerminal) {
          for (const origin of recipes.values()) {
            if (
              origin.host !== entry.host ||
              !origin.endpoint ||
              (awaitingTrust && origin.phase === "finished")
            )
              continue;
            originTerminals.set(originRecipeKey(entry.host, origin.endpoint), {
              running: origin.phase !== "finished",
              panel: originPanel(origin.id, origin.reveal),
            });
          }
        }
        const summary = hostSummary(preflight);
        const setupAgent = entry.setupAgent;

        const codexApprovals = preflight?.result.ok
          ? preflight.result.facts.agents.find((agent) => agent.id === "codex")?.codexApprovals
          : undefined;
        const distro = entry.result?.ok ? entry.result.facts.requirements?.distro : undefined;
        const os = distro === "darwin" ? "macOS" : distro;
        const open =
          expanded.get(entry.host) ??
          (!!recipe ||
            originTerminals.size > 0 ||
            summary === "Needs you" ||
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
              {codexApprovals === "may-prompt" && (
                <span className="host-count codex-approval-advisory">
                  Codex may prompt for approval
                </span>
              )}
              <span
                className={`host-count ${summary === "Needs you" && !setupAgent ? "host-need" : ""}`}
              >
                {setupAgent ? (
                  <span className="host-setup-running" role="status">
                    <Status tone="work">Setting up · {setupAgent.name}</Status>
                  </span>
                ) : busy.has(entry.host) ? (
                  <span className="host-check-progress host-work" role="status">
                    <span className="host-throbber" aria-hidden="true" />
                    {hostProgressText(progress?.find((item) => item.host === entry.host))}
                  </span>
                ) : (
                  summary
                )}
              </span>
              {!setupAgent && !untrusted && (
                <button
                  type="button"
                  className={summary === "Ready" ? undefined : "primary"}
                  disabled={controlsDisabled}
                  onClick={() => {
                    setSetupHost(entry.host);
                  }}
                >
                  Set up with an agent…
                </button>
              )}
            </div>
            <div className="host-body" hidden={!open}>
              <fieldset className="host-controls" disabled={controlsDisabled}>
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
                  {setupAgent && (
                    <button
                      type="button"
                      onClick={() => {
                        void api?.({
                          action: "show-setup-agent",
                          host: entry.host,
                          id: setupAgent.id,
                        }).catch(() => {
                          setError("Unable to show setup agent");
                        });
                      }}
                    >
                      Show agent
                    </button>
                  )}
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
                {!awaitingTrust &&
                  !(recipeAction?.action === "recipe" && recipeAction.operation === "sign-in") &&
                  terminal}
              </fieldset>
              <ReloadContext
                value={{
                  reload: (target) => {
                    void reload(entry.host, target, sshRevision);
                  },
                  needsFullCheck:
                    (preflight?.result ?? entry.result)?.ok !== true || summary === "Not checked",
                  saveFailed: new Set(
                    (entry.rowFailures ?? [])
                      .filter((row) => row.reason === "save-failed")
                      .map((row) => rowKey(row.target)),
                  ),
                  failed: new Set([
                    ...[...rowFailed]
                      .filter(
                        ([key, failedAt]) =>
                          key.startsWith(`${entry.host}:`) &&
                          (key !== `${entry.host}:${sshRowKey}` || failedAt >= sshRevision),
                      )
                      .map(([key]) => key.slice(entry.host.length + 1)),
                    ...(entry.rowFailures ?? []).map((row) => rowKey(row.target)),
                  ]),
                  pending: new Set([
                    ...[...rowPending]
                      .filter((key) => key.startsWith(`${entry.host}:`))
                      .map((key) => key.slice(entry.host.length + 1)),
                    ...(recipe?.phase === "checking" && recipe.installTool
                      ? [rowKey({ kind: "tool", tool: recipe.installTool })]
                      : []),
                  ]),
                }}
              >
                <Checklist
                  gitOrigins={state.gitOrigins}
                  originTerminals={originTerminals}
                  signInTerminal={
                    !awaitingTrust &&
                    recipe &&
                    !recipe.gh &&
                    recipeAction?.action === "recipe" &&
                    recipeAction.operation === "sign-in"
                      ? {
                          tool: recipeAction.tool,
                          running: recipe.phase !== "finished",
                          panel: terminal,
                        }
                      : undefined
                  }
                  ghRunning={!!recipe?.gh && recipe.phase !== "finished"}
                  ghPanel={
                    !awaitingTrust && recipe?.gh ? (
                      <GithubSignInPanel
                        key={recipe.id}
                        id={recipe.id}
                        host={entry.host}
                        source={source}
                        finished={recipeFinished}
                        refreshTool={refreshGithubTool}
                        installing={recipe.gh === "install"}
                        retry={() => {
                          void act({
                            action: "recipe",
                            host: entry.host,
                            tool: "gh",
                            operation: recipe.gh === "install" ? "install-sign-in" : "sign-in",
                          });
                        }}
                      />
                    ) : undefined
                  }
                  awaitingTrust={awaitingTrust}
                  ssh={ssh}
                  copySsh={() =>
                    source.copyHost?.({ kind: "copy-host-ssh-command", host: entry.host }) ??
                    Promise.reject(new Error("Copy unavailable"))
                  }
                  enabledAgents={agents}
                  openAgents={openAgents}
                  entry={entry}
                  preflight={preflight}
                  progress={progress?.find((item) => item.host === entry.host)}
                  checking={checkingHosts.has(entry.host)}
                  disabled={controlsDisabled}
                  act={(action) => {
                    void act(action);
                  }}
                  changeFolder={() => {
                    setChanging({ host: entry.host, folder: entry.codeFolder });
                  }}
                />
              </ReloadContext>
              <fieldset className="host-controls" disabled={controlsDisabled}>
                {!awaitingTrust && changing?.host === entry.host && (
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
                    <button
                      type="submit"
                      disabled={busy.has(entry.host) || !changing.folder.trim()}
                    >
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
                {!awaitingTrust && (
                  <>
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
                        disabled={controlsDisabled}
                        onClick={() => {
                          void act({
                            action: "preflight",
                            host: entry.host,
                            codeFolder: entry.codeFolder,
                          });
                        }}
                        className="agent-reload"
                        aria-label="Check capabilities"
                        title={`Re-check ${hostDisplayName(entry)}`}
                      >
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
                      </button>
                    </footer>
                    <details className="host-details">
                      <summary>Host facts</summary>
                      <button
                        type="button"
                        disabled={controlsDisabled}
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
                      {entry.factsRefreshFailure && (
                        <p role="status">
                          <Status tone={failureTone(entry.factsRefreshFailure)}>
                            {reasons[entry.factsRefreshFailure]}
                          </Status>
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
                      {checkouts.length > 0 && (
                        <dl className="host-facts host-checkouts">
                          <dt>Checked out repositories</dt>
                          <dd>
                            <ul>
                              {checkouts.map(({ repository, path }) => (
                                <li key={repository}>
                                  {repository.split(/[\\/]/u).at(-1)} · <code>{path}</code>
                                </li>
                              ))}
                            </ul>
                          </dd>
                        </dl>
                      )}
                    </details>
                  </>
                )}
              </fieldset>
            </div>
          </section>
        );
      })}
      {api && setupEntry && (
        <HostSetupDialog
          host={hostDisplayName(setupEntry)}
          agents={(setupAgents ?? []).filter(
            (agent) => agent.path && agent.initialPrompt && agents?.[agent.id] === true,
          )}
          defaultAgent={defaultAgent}
          repositories={repositories}
          close={() => {
            setSetupHost(undefined);
          }}
          start={async (agent, repositories) => {
            const next = await api({
              action: "setup-agent",
              host: setupEntry.host,
              agent,
              repositories,
            });
            setState(next);
          }}
        />
      )}
    </div>
  );
}
export function RepositoryHosts({
  source,
  repositories,
  headingRef,
}: {
  source: Pick<
    SetupSource,
    "hosts" | "copyHost" | "views" | "hostTerminal" | "repositoryRequirements"
  >;
  repositories: readonly Repository[];
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const hostsQuery = useHostsView(
    source,
    () => source.hosts?.({ action: "locations" }) ?? Promise.resolve(EMPTY_HOSTS),
  );
  const [state, setState] = useViewState(hostsQuery, EMPTY_HOSTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const api = source.hosts;
  useEffect(() => {
    if (!source.views) return;
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
  }, [api, repositories, setState, source.views]);
  const act = async (action: HostsAction) => {
    setBusy(true);
    setError("");
    try {
      const next = await api?.(action);
      if (next) setState(next);
    } catch {
      setError("Unable to check locations");
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
      {(error || hostsQuery.isError) && (
        <p role="alert" className="hosts-failure">
          {error || "Unable to check locations"}
        </p>
      )}
      {source.repositoryRequirements && (
        <RepositoryRequirementsCards
          repositories={repositories}
          request={source.repositoryRequirements}
        />
      )}
      {[{ host: null, codeFolder: "" }, ...state.hosts].map((host) => {
        const checked = repositories.filter(
          (repo) =>
            host.host === null ||
            state.locations.some(
              (entry) =>
                entry.host === host.host &&
                entry.repository === repo.path &&
                entry.result.ok &&
                entry.result.checkout &&
                entry.result.checkout.state !== "absent",
            ),
        );
        return (
          <section
            className="host-card repository-host-card"
            key={host.host ?? "local"}
            aria-label={host.host ?? "Local"}
          >
            <header className="hosts-heading">
              <h3>{host.host === null ? "Local" : hostDisplayName(host)}</h3>
              <span className="host-tag">
                {checked.length} {checked.length === 1 ? "repository" : "repositories"}
              </span>
              <code>{host.codeFolder}</code>
            </header>
            {checked.map((repo) => {
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
                </div>
              );
            })}
          </section>
        );
      })}
    </section>
  );
}
