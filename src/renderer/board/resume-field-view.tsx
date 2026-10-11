import { useConfirmation } from "./use-confirmation";
import type { ConfirmationClient } from "../../shared/confirmation";
import { useEffect, useRef, useState } from "react";
import type { AgentId } from "../../shared/agents";
import { agentBadges, agentNames } from "./sidebar-model";
import { parseResume } from "./resume-field";

export function ResumeField({
  agents,
  confirmations,
  back,
  launch,
}: {
  agents: readonly AgentId[];
  confirmations?: ConfirmationClient | undefined;
  back: () => void;
  launch: (agent: AgentId, id: string) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<AgentId>();
  const [failed, setFailed] = useState(false);
  const confirmation = useConfirmation(confirmations);
  const pending = confirmation.pending;
  const parsed = parseResume(text);
  const agent = parsed?.agent ?? choice;
  const invalid =
    failed ||
    (text.length > 0 &&
      (!parsed || (parsed.agent !== undefined && !agents.includes(parsed.agent))));
  useEffect(() => {
    if (!pending) inputRef.current?.focus();
  }, [pending]);
  useEffect(() => {
    if (confirmation.arm) confirmationRef.current?.focus();
  }, [confirmation.arm]);
  const submit = async () => {
    if (pending) return;
    if (!parsed || !agent || !agents.includes(agent)) {
      setFailed(true);
      return;
    }
    try {
      await confirmation.run(() => launch(agent, parsed.id));
    } catch {
      setFailed(true);
    }
  };
  return (
    <div
      className="branch-field resume-field"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          const item = inputRef.current
            ?.closest(".sidebar-panel")
            ?.querySelector<HTMLElement>("[data-expands]");
          back();
          item?.focus();
        }
      }}
    >
      <input
        ref={inputRef}
        aria-label="Conversation ID or resume command"
        aria-invalid={invalid}
        autoComplete="off"
        spellCheck={false}
        value={text}
        disabled={pending}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setFailed(false);
          setChoice(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {confirmation.arm && (
        <button
          type="button"
          data-armed
          ref={confirmationRef}
          onClick={() => {
            void confirmation.run(() => undefined);
          }}
        >
          {confirmation.arm.label}
        </button>
      )}
      {invalid && (
        <span className="resume-invalid" aria-hidden="true">
          ×
        </span>
      )}
      {parsed && !parsed.agent && (
        <div className="resume-agents" role="group" aria-label="Agent">
          {agents.map((id) => (
            <button
              key={id}
              type="button"
              aria-label={agentNames.get(id)}
              aria-pressed={choice === id}
              disabled={pending}
              onClick={() => {
                setChoice(id);
                setFailed(false);
                inputRef.current?.focus();
              }}
            >
              {agentBadges.get(id)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
