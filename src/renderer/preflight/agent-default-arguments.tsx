import { useState } from "react";
import type { AgentId } from "../../shared/agents";
import { AGENTS } from "./preflight";
import { message } from "./preflight-evaluator";

export function AgentDefaultArguments({
  defaults,
  save,
}: {
  defaults: Readonly<Record<AgentId, readonly string[]>>;
  save: (defaults: Readonly<Record<AgentId, readonly string[]>>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Partial<Record<AgentId, string>>>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const text = (agent: AgentId) => draft[agent] ?? defaults[agent].join("\n");
  const argumentsFor = (agent: AgentId) => (text(agent) === "" ? [] : text(agent).split("\n"));
  return (
    <form
      className="agent-defaults"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setStatus("");
        void save({
          claude: argumentsFor("claude"),
          codex: argumentsFor("codex"),
          agy: argumentsFor("agy"),
        })
          .then(
            () => {
              setDraft({});
              setStatus("Default arguments saved. They apply to future launches.");
            },
            (error: unknown) => {
              setStatus(message(error));
            },
          )
          .finally(() => {
            setSaving(false);
          });
      }}
    >
      <h3>Default launch arguments</h3>
      <p id="agent-defaults-help">
        One argument per line, including each flag’s value on its own line. Spaces and quotes are
        passed literally; do not add shell quotes. Leave empty to use your global agent config. Foom
        adds its own terminal and attention flags after these defaults.
      </p>
      {AGENTS.map(({ id, name }) => (
        <label key={id}>
          {name} default arguments
          <textarea
            aria-describedby="agent-defaults-help"
            rows={4}
            spellCheck={false}
            disabled={saving}
            value={text(id)}
            onChange={(event) => {
              setDraft({ ...draft, [id]: event.target.value });
              setStatus("");
            }}
          />
        </label>
      ))}
      <button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save default arguments"}
      </button>
      <p role="status">{status}</p>
    </form>
  );
}
