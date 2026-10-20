import { repositoryKey } from "./sidebar-model";
import { ActionError, useBackgroundErrors } from "./error-presentation";
import { errorMessage } from "../../shared/application-errors";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { BranchInventory, CreateOutcome, Worktree } from "../../shared/worktrees";
import type { WorktreeSource } from "./board-source.d";
import { branchCandidates, branchOutcome, normalizeBranch, pendingText } from "./branch-field";

const EMPTY: BranchInventory = { head: null, local: [], remote: null, remoteBranches: [] };

function message(error: unknown): string {
  return errorMessage(error, "Unable to create the worktree.");
}

/**
 * The branch field beside a repository panel's New worktree item. Enter creates or opens a
 * worktree and starts nothing; the caller moves focus to the arriving row.
 */
export function BranchField({
  repository,
  source,
  back,
  created,
}: {
  repository: string;
  source: Pick<WorktreeSource, "branches" | "create">;
  /** Return to the New worktree item. */
  back: () => void;
  created: (worktree: Worktree & { outcome: CreateOutcome }) => void;
}) {
  const { report, clear } = useBackgroundErrors();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const [text, setText] = useState("");
  const [pick, setPick] = useState(0);
  const [data, setData] = useState<BranchInventory>();
  const [pending, setPending] = useState<string>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    let active = true;
    source.branches(repository).then(
      (next) => {
        if (active) {
          setData(next);
          clear(`branches:${repository}`);
        }
      },
      () => {
        if (!active) return;
        // Completions are a convenience: the field still works, and main still validates.
        setData(EMPTY);
        report(
          `branches:${repository}`,
          "Unable to read branch completions.",
          repositoryKey(repository),
        );
      },
    );
    return () => {
      active = false;
    };
  }, [source, repository, clear, report]);
  useLayoutEffect(() => {
    if (caretRef.current === null) return;
    inputRef.current?.setSelectionRange(caretRef.current, caretRef.current);
    caretRef.current = null;
  });
  // Runs after the panel's own layout effect, which focuses its first command, and again
  // when a failure re-enables the field.
  useEffect(() => {
    if (!pending && !failure) inputRef.current?.focus();
  }, [pending, failure]);
  const inventory = data ?? EMPTY;
  const candidates = data ? branchCandidates(inventory, text) : [];
  const candidate = candidates[pick % Math.max(1, candidates.length)];
  const outcome = data ? branchOutcome(inventory, text) : undefined;
  const invalid = outcome?.kind === "invalid";
  const returnToItem = () => {
    const item = inputRef.current
      ?.closest(".sidebar-panel")
      ?.querySelector<HTMLElement>("[data-expands]");
    back();
    item?.focus({ preventScroll: true });
  };
  const submit = () => {
    if (!outcome || outcome.kind === "invalid" || pending) return;
    setFailure(undefined);
    setPending(outcome.kind === "open" ? "" : pendingText(inventory, outcome.kind));
    source.create(repository, text).then(created, (error: unknown) => {
      setFailure(message(error));
      setPending(undefined);
    });
  };
  const line = pending !== undefined ? { text: pending, kind: "pending" } : outcome;
  return (
    <div className="branch-field">
      {failure && (
        <ActionError
          returnFocus={() => inputRef.current}
          message={failure}
          close={() => {
            setFailure(undefined);
          }}
        />
      )}
      <div className="branch-box" data-invalid={invalid || undefined}>
        {candidate && (
          <span className="branch-ghost" aria-hidden="true">
            <span className="branch-typed">{text}</span>
            {candidate.inline ? (
              <span className="branch-rest">{candidate.value.slice(text.length)} ⇥</span>
            ) : (
              <span className="branch-other">{candidate.value} ⇥</span>
            )}
          </span>
        )}
        <input
          ref={inputRef}
          aria-label="Branch for the new worktree"
          aria-describedby={statusId}
          aria-invalid={invalid || undefined}
          spellCheck={false}
          autoComplete="off"
          disabled={pending !== undefined}
          value={text}
          onChange={(event) => {
            const value = normalizeBranch(event.currentTarget.value);
            caretRef.current = event.currentTarget.selectionStart;
            setText(value);
            setPick(0);
            setFailure(undefined);
          }}
          onKeyDown={(event) => {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && candidates.length) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setPick((pick + step + candidates.length) % candidates.length);
            } else if (event.key === "Tab" && !event.shiftKey && candidate) {
              event.preventDefault();
              setText(candidate.value);
              setPick(0);
              caretRef.current = candidate.value.length;
            } else if (event.key === "Escape" || (event.key === "ArrowLeft" && !text)) {
              event.preventDefault();
              event.stopPropagation();
              returnToItem();
            } else if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <div
        id={statusId}
        className="branch-status"
        aria-label="Branch status"
        role="status"
        data-kind={line?.kind}
        data-invalid={line?.kind === "invalid" || undefined}
      >
        {line?.text}
      </div>
    </div>
  );
}
