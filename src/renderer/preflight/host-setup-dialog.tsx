import { useId, useLayoutEffect, useRef, useState } from "react";
import type { AgentInstallation } from "../../shared/agents";
import type { Repository } from "../../shared/worktrees";

export function HostSetupDialog({
  host,
  agents,
  defaultAgent,
  repositories,
  close,
  start,
}: {
  host: string;
  agents: readonly AgentInstallation[];
  defaultAgent: string | null;
  repositories: readonly Repository[];
  close: () => void;
  start: (agent: string, repositories: readonly string[]) => Promise<void>;
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
  const [failed, setFailed] = useState(false);
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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (starting || !chosen || !selection.length) return;
          setStarting(true);
          setFailed(false);
          void start(chosen, selection).then(close, () => {
            setStarting(false);
            setFailed(true);
          });
        }}
      >
        <label className="host-setup-agent-picker">
          Agent
          <select
            ref={pickerRef}
            value={chosen}
            disabled={starting}
            onChange={(event) => {
              setAgent(event.target.value);
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
        {failed && <p role="alert">Unable to start setup agent</p>}
        <footer>
          <button type="button" disabled={starting} onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={starting || !chosen || !selection.length}
          >
            {starting ? "Starting…" : "Start agent"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
