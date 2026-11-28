import { useId, useLayoutEffect, useRef, useState } from "react";
import type { AgentInstallation } from "../../shared/agents";
import type { HostSetupFailureReason } from "../../shared/registered-hosts.d";
import type { Repository } from "../../shared/worktrees";

type Recovery = "local" | "global" | "choose-agent" | "refresh-host" | "show-host";

const recoveryLabels: Record<Recovery, string> = {
  local: "Open Agents settings",
  global: "Open Agents settings",
  "choose-agent": "Choose another agent",
  "refresh-host": "Refresh host",
  "show-host": "Review host key",
};

const failures: Record<HostSetupFailureReason, { text: string; recovery?: Recovery }> = {
  "setup-unavailable": { text: "Host setup is unavailable in this window." },
  "setup-cancelled": { text: "Setup was cancelled. Reopen the dialog to try again." },
  "setup-running": { text: "A setup agent is already starting or running for this host." },
  "host-changed": { text: "The host registration changed. Reopen setup from Hosts." },
  "repositories-changed": { text: "A selected repository was removed. Update the selection." },
  "origin-unavailable": { text: "Local Git origin unavailable. Check the selected repositories." },
  "brief-too-long": { text: "The setup brief is too long. Select fewer repositories." },
  "host-key-unknown": { text: "The SSH host key needs your approval.", recovery: "show-host" },
  "host-key-changed": { text: "The SSH host key changed.", recovery: "show-host" },
  "ssh-login-rejected": { text: "SSH rejected the login. Check your SSH credentials." },
  "ssh-unreachable": { text: "Could not reach the host over SSH.", recovery: "refresh-host" },
  "agent-disabled": { text: "The local agent is turned off.", recovery: "local" },
  "agent-missing": { text: "The local agent executable is unavailable.", recovery: "local" },
  "agent-prompt-unsupported": {
    text: "This agent cannot receive a setup brief.",
    recovery: "choose-agent",
  },
  "agent-discovery-failed": { text: "The local agent scan failed.", recovery: "local" },
  "agent-provider-changed": {
    text: "The agent plugin changed. Rescan local agents.",
    recovery: "local",
  },
  "agent-arguments-invalid": {
    text: "The agent’s default arguments are invalid.",
    recovery: "global",
  },
  "agent-permission-conflict": {
    text: "Default arguments conflict with the permission level.",
    recovery: "global",
  },
  "agent-permission-unavailable": {
    text: "The agent version cannot use this permission level.",
    recovery: "local",
  },
  "agent-permission-acknowledgement": {
    text: "Full access needs a new approval.",
    recovery: "local",
  },
  "agent-permission-changed": { text: "Agent permissions changed. Try starting again." },
  "agent-environment-conflict": {
    text: "Bypass environment variables conflict with the permission level. Review Settings → Environment.",
  },
  "agent-bypass-cancelled": { text: "Bypass approval was cancelled.", recovery: "choose-agent" },
  "agent-hooks-conflict": { text: "Foom could not attach the agent hooks.", recovery: "local" },
  "launch-failed": { text: "The local agent failed to start. Try again." },
};

function isHostSetupFailure(value: unknown): value is HostSetupFailureReason {
  return typeof value === "string" && Object.hasOwn(failures, value);
}

export function hostSetupFailurePresentation(value: unknown) {
  return failures[isHostSetupFailure(value) ? value : "launch-failed"];
}

export function HostSetupDialog({
  host,
  agents,
  defaultAgent,
  repositories,
  close,
  start,
  openAgentSettings,
  refreshHost,
  showHost,
}: {
  host: string;
  agents: readonly AgentInstallation[];
  defaultAgent: string | null;
  repositories: readonly Repository[];
  close: () => void;
  start: (
    agent: string,
    repositories: readonly string[],
  ) => Promise<HostSetupFailureReason | undefined>;
  openAgentSettings?: ((scope: "local" | "global") => void) | undefined;
  refreshHost: () => void;
  showHost: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pickerRef = useRef<HTMLSelectElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const repositoryLabelId = useId();
  const [agent, setAgent] = useState<string>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof hostSetupFailurePresentation>>();
  const chosen =
    agents.find(({ id }) => id === agent)?.id ??
    agents.find(({ id }) => id === defaultAgent)?.id ??
    agents[0]?.id ??
    "";
  const query = filter.trim().toLowerCase();
  const visible = repositories.filter(
    ({ path, name }) => selected.has(path) || name.toLowerCase().includes(query),
  );
  const selection = repositories.filter(({ path }) => selected.has(path)).map(({ path }) => path);

  const recovery =
    failure?.recovery === "choose-agent" && agents.length < 2 ? "local" : failure?.recovery;
  const recover = (action: Recovery) => {
    switch (action) {
      case "local":
      case "global":
        openAgentSettings?.(action);
        break;
      case "choose-agent":
        pickerRef.current?.focus();
        break;
      case "refresh-host":
        refreshHost();
        break;
      case "show-host":
        showHost();
        break;
    }
  };
  const launch = async () => {
    setStarting(true);
    setFailure(undefined);
    try {
      const reason = await start(chosen, selection);
      if (reason === undefined) close();
      else setFailure(hostSetupFailurePresentation(reason));
    } catch {
      setFailure(hostSetupFailurePresentation(undefined));
    } finally {
      setStarting(false);
    }
  };

  useLayoutEffect(() => {
    const element = dialogRef.current;
    element?.showModal();
    pickerRef.current?.focus();
    return () => {
      element?.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="host-setup-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!starting) close();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => {
        if (starting || event.target !== event.currentTarget) return;
        const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
        const { clientX, clientY } = event;
        if (clientX < left || clientX > right || clientY < top || clientY > bottom) close();
      }}
    >
      <h2 id={titleId}>Set up {host} with an agent</h2>
      <p id={descriptionId}>
        The agent runs on this computer, connects to {host} over SSH, and installs what the selected
        repositories need. It works in its own tile and will ask you there if it needs a password or
        a decision.
      </p>
      <div>
        <label className="host-setup-agent-picker">
          Agent
          <select
            ref={pickerRef}
            value={chosen}
            disabled={starting}
            onChange={(event) => {
              setAgent(event.target.value);
              setFailure(undefined);
            }}
          >
            {agents.length === 0 && <option value="">No agents available</option>}
            {agents.map(({ id, name }) => (
              <option key={id} value={id}>
                {name ?? id}
              </option>
            ))}
          </select>
        </label>
        <div className="host-setup-repository-heading">
          <span id={repositoryLabelId}>Repositories</span>
          <input
            type="search"
            placeholder="Filter"
            aria-label="Filter repositories"
            value={filter}
            disabled={starting}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </div>
        <div className="host-setup-repositories" role="group" aria-labelledby={repositoryLabelId}>
          {visible.map(({ path, name }) => (
            <label key={path}>
              <input
                type="checkbox"
                checked={selected.has(path)}
                disabled={starting}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (checked) next.add(path);
                    else next.delete(path);
                    return next;
                  });
                }}
              />
              {name}
            </label>
          ))}
          {visible.length === 0 && <p>{repositories.length ? "No matches" : "No repositories"}</p>}
        </div>
        <footer>
          <button type="button" disabled={starting} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={starting || !chosen || !selection.length}
            onClick={() => {
              void launch();
            }}
          >
            {starting ? "Starting…" : "Start agent"}
          </button>
        </footer>
        {failure && (
          <p role="alert">
            {failure.text}
            {recovery && (
              <>
                {" "}
                {(recovery === "local" || recovery === "global") && !openAgentSettings ? (
                  `${recoveryLabels[recovery]}.`
                ) : (
                  <button
                    type="button"
                    className="host-setup-recovery"
                    onClick={() => {
                      recover(recovery);
                    }}
                  >
                    {recoveryLabels[recovery]}
                  </button>
                )}
              </>
            )}
          </p>
        )}
      </div>
    </dialog>
  );
}
