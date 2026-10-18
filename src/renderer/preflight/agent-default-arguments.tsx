import { hasBypassArgument } from "../../shared/providers/arguments";
import { useState } from "react";
import type { AgentId } from "../../shared/agents";
import { message } from "./message";

/** Keep interior lines for useful error locations; only trailing empty lines are ignored. */
export function argumentLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

export function AgentArguments({
  id,
  name,
  value,
  bypass = [],
  save,
}: {
  id: AgentId;
  name: string;
  value: readonly string[];
  bypass?: readonly string[];
  save: (args: readonly string[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const text = draft ?? value.join("\n");
  const args = argumentLines(text);
  return (
    <div>
      <textarea
        aria-label={`${name} default arguments`}
        rows={Math.max(1, args.length)}
        spellCheck={false}
        placeholder="None"
        value={text}
        disabled={busy}
        onChange={(event) => {
          setDraft(event.target.value);
          setError("");
        }}
        onBlur={() => {
          if (draft === undefined || text === value.join("\n")) return;
          setError("");
          setBusy(true);
          void save(args)
            .then(
              () => {
                setDraft(undefined);
              },
              (caught: unknown) => {
                setError(message(caught));
              },
            )
            .finally(() => {
              setBusy(false);
            });
        }}
      />
      {(hasBypassArgument(id, args) || bypass.some((arg) => args.includes(arg))) && (
        <p className="agent-bypass">◇ Bypass approvals · Agent can act anywhere on this machine.</p>
      )}
      {error && (
        <p className="preflight-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
