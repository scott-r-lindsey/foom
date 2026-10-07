import { useState } from "react";
import type { AgentId } from "../../shared/agents";
import { AGENTS } from "./preflight";
import { message } from "./preflight-evaluator";

/** Keep interior lines for useful error locations; only trailing empty lines are ignored. */
export function argumentLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

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
  const argumentsFor = (agent: AgentId) => argumentLines(text(agent));
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
        One argument per line; values on separate lines. Passed literally before Foom’s flags.
        Trailing blank lines are ignored.
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
