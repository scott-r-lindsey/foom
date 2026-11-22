import { useEffect, useId, useRef, useState } from "react";
import type {
  BoardDecision,
  BoardDecisions,
  DecisionAddress,
  DecisionAnswer,
  DecisionChoice,
  MessageBoardApi,
} from "../../shared/message-board";
import {
  DECISION_ANSWER_BYTE_LIMIT,
  boardAnswers,
  boardText,
  decisionAnswerBytes,
} from "../../shared/message-board-validation";

export function decisionLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "decision" : "decisions"}`;
}

export function decisionKey({ post, index }: DecisionAddress): string {
  return `${post}:${String(index)}`;
}

export function DecisionPill({
  count,
  hidden,
  onOpen,
}: {
  count: number;
  hidden: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="decision-pill"
      aria-label={`${decisionLabel(count)} needed from you`}
      hidden={hidden}
      onClick={onOpen}
    >
      <span aria-hidden="true">◇</span> {decisionLabel(count)}
    </button>
  );
}

const emptyDecisions: BoardDecisions = { counts: {}, questions: [] };

export function useDecisionCounts(
  query: MessageBoardApi["decisions"],
  subscribe: (listener: () => void) => () => void,
): BoardDecisions {
  const [snapshot, setSnapshot] = useState(emptyDecisions);
  useEffect(() => {
    if (!query) return;
    let active = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      void query({ watch: [] })
        .then((next) => {
          if (!active || current !== revision) return;
          setSnapshot((previous) =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
          );
        })
        .catch(() => {});
    };
    const unsubscribe = subscribe(refresh);
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [query, subscribe]);
  return snapshot;
}

function DecisionPreview({
  row,
  preview,
}: {
  row: BoardDecision;
  preview: NonNullable<MessageBoardApi["preview"]>;
}) {
  const [image, setImage] = useState<string | null>();
  const { post, index } = row;
  useEffect(() => {
    let active = true;
    void preview({ post, index }).then(
      (result) => {
        if (active) setImage(result);
      },
      () => {
        if (active) setImage(null);
      },
    );
    return () => {
      active = false;
    };
  }, [post, index, preview]);
  return (
    <figure className="decision-preview">
      {image ? (
        <img src={image} alt={`Preview of ${row.question.preview?.path ?? "document"}`} />
      ) : (
        <div role="status">{image === null ? "Preview unavailable" : "Loading preview…"}</div>
      )}
      <figcaption>{row.question.preview?.path}</figcaption>
    </figure>
  );
}

const statusText = {
  open: "",
  checking: "Checking subject",
  stale: "Stale · PR head changed",
  withdrawn: "Withdrawn",
  answered: "Answered",
};

const checksText = {
  success: "Checks passed",
  pending: "Checks pending",
  failure: "Checks failed",
  none: "No required checks",
  unknown: "Checks unknown",
};

function usableChoice(choice: DecisionChoice | undefined): boolean {
  if (!choice) return false;
  if (choice.option !== undefined) return true;
  try {
    boardText(choice.other);
    return true;
  } catch {
    return false;
  }
}

function QuestionPage({
  row,
  choice,
  choose,
  preview,
}: {
  row: BoardDecision;
  choice: DecisionChoice | undefined;
  choose: (choice: DecisionChoice) => void;
  preview: MessageBoardApi["preview"];
}) {
  const groupId = useId();
  const titleId = useId();
  const { question, status, checks, movedHead } = row;
  const locked = status !== "open";
  return (
    <>
      {(question.subject || status !== "open") && (
        <div className="decision-subject" data-status={status}>
          {question.subject && (
            <span className="decision-badge">
              <span>PR #{question.subject.pullRequest}</span>
              <code>
                {status === "stale" ? (
                  <>
                    <s>{question.subject.headSha.slice(0, 8)}</s>
                    {movedHead && <> → {movedHead.slice(0, 8)}</>}
                  </>
                ) : (
                  question.subject.headSha.slice(0, 8)
                )}
              </code>
            </span>
          )}
          {checks && status === "open" && <span data-checks={checks}>{checksText[checks]}</span>}
          {locked && (
            <span role="status">{status === "stale" ? "Head moved" : statusText[status]}</span>
          )}
        </div>
      )}
      <h3 id={titleId}>{status === "withdrawn" ? <s>{question.title}</s> : question.title}</h3>
      {question.detail && <p>{question.detail}</p>}
      {status === "stale" && <p>Answers disabled until main re-asks at the new head</p>}
      {preview && question.preview && status !== "withdrawn" && (
        <DecisionPreview row={row} preview={preview} />
      )}
      <fieldset
        className="decision-options"
        disabled={locked}
        aria-disabled={locked}
        aria-labelledby={titleId}
      >
        {question.options.map(({ id, label, hint }) => (
          <label key={id} className="decision-option">
            <input
              type="radio"
              name={groupId}
              checked={!locked && choice?.option === id}
              aria-disabled={locked}
              onChange={() => {
                choose({ option: id });
              }}
            />
            <span>
              {label}
              {hint && <small>{hint}</small>}
            </span>
          </label>
        ))}
        <label className="decision-option decision-other">
          <span aria-hidden="true" data-selected={!locked && choice?.other !== undefined}>
            ◯
          </span>
          <input
            type="text"
            aria-label="Other answer"
            aria-disabled={locked}
            placeholder="Other…"
            maxLength={8192}
            value={locked ? "" : (choice?.other ?? "")}
            onChange={(event) => {
              choose({ other: event.target.value });
            }}
          />
        </label>
      </fieldset>
    </>
  );
}

export interface DecisionDraft {
  position: string | null;
  choices: Record<string, DecisionChoice | undefined>;
}
export interface DecisionSession {
  repository: string;
  name: string;
  questions: BoardDecision[];
  draft?: DecisionDraft;
}

export function DecisionsDialog({
  session,
  api,
  subscribe,
  close,
}: {
  session: DecisionSession;
  api: MessageBoardApi;
  subscribe: (listener: () => void) => () => void;
  close: (draft?: DecisionDraft) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [rows, setRows] = useState(session.questions);
  const [step, setStep] = useState(() =>
    session.draft?.position === null
      ? session.questions.length
      : Math.max(
          0,
          session.questions.findIndex(
            (question) => decisionKey(question) === session.draft?.position,
          ),
        ),
  );
  const [choices, setChoices] = useState(session.draft?.choices ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingRef = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  useEffect(() => {
    if (!api.decisions) return;
    const query = api.decisions;
    let revision = 0;
    const watch = session.questions.map(({ post, index }) => ({ post, index }));
    const refresh = () => {
      const current = ++revision;
      void query({ watch })
        .then(({ questions }) => {
          if (current !== revision) return;
          setRows(
            session.questions.map(
              (seed) =>
                questions.find((row) => decisionKey(row) === decisionKey(seed)) ?? {
                  ...seed,
                  status: "withdrawn",
                },
            ),
          );
        })
        .catch(() => {});
    };
    const unsubscribe = subscribe(refresh);
    refresh();
    return () => {
      revision++;
      unsubscribe();
    };
  }, [api, session, subscribe]);
  const row = rows[step];
  const key = row && decisionKey(row);
  const choice = key === undefined ? undefined : choices[key];
  const hide = () => {
    close({ position: key ?? null, choices });
  };
  const answers: DecisionAnswer[] = rows.flatMap(({ status, post, index }) => {
    const picked = choices[decisionKey({ post, index })];
    return status === "open" && picked && usableChoice(picked) ? [{ post, index, ...picked }] : [];
  });
  const oversized = decisionAnswerBytes(answers) > DECISION_ANSWER_BYTE_LIMIT;
  const move = (next: number) => {
    setError("");
    setStep(next);
  };
  const submit = async () => {
    if (!api.answer || busy || !answers.length || oversized) return;
    const fingerprint = JSON.stringify(answers);
    const key =
      pendingRef.current?.fingerprint === fingerprint
        ? pendingRef.current.key
        : crypto.randomUUID();
    pendingRef.current = { fingerprint, key };
    setBusy(true);
    setError("");
    try {
      await api.answer(boardAnswers({ answers, idempotencyKey: key }));
      close();
    } catch {
      setError("Unable to submit answers. Check the decisions and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialogRef}
      className="decisions-dialog"
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) hide();
      }}
    >
      <div className="decisions-content">
        <header>
          <h2 id={headingId}>{session.name} · decisions</h2>
          <span className="decision-progress" aria-hidden="true">
            {rows.map((item, index) => (
              <i
                key={decisionKey(item)}
                data-step={
                  index === step
                    ? "current"
                    : item.status === "open" && usableChoice(choices[decisionKey(item)])
                      ? "visited"
                      : "pending"
                }
              />
            ))}
            <i data-step={row ? "pending" : "current"} />
          </span>
          <span className="decision-position">
            {row ? `${String(step + 1)} / ${String(rows.length)}` : "Review"}
          </span>
          <button type="button" disabled={busy} onClick={hide}>
            Hide
          </button>
        </header>
        <div className="decisions-body">
          {row && key !== undefined ? (
            <QuestionPage
              key={key}
              row={row}
              choice={choice}
              choose={(next) => {
                setChoices((previous) => ({ ...previous, [key]: next }));
              }}
              preview={api.preview}
            />
          ) : (
            <>
              <h3>Send to {session.name}</h3>
              <ol className="decision-review">
                {rows.map((item, index) => {
                  const id = decisionKey(item);
                  const picked = choices[id];
                  const answer =
                    item.status === "open" && usableChoice(picked)
                      ? (picked?.other ??
                        item.question.options.find(({ id }) => id === picked?.option)?.label)
                      : undefined;
                  return (
                    <li key={id}>
                      <span>
                        {item.status === "withdrawn" ? (
                          <s>{item.question.title}</s>
                        ) : (
                          item.question.title
                        )}
                      </span>
                      <span data-answered={Boolean(answer)}>
                        {answer ??
                          (item.status === "open"
                            ? "Skipped · stays open"
                            : statusText[item.status])}
                      </span>
                      <button
                        type="button"
                        aria-label={`Change ${item.question.title}`}
                        disabled={busy || item.status !== "open"}
                        onClick={() => {
                          move(index);
                        }}
                      >
                        Change
                      </button>
                    </li>
                  );
                })}
              </ol>
              {oversized && (
                <p role="alert">
                  Answers exceed the 8,192 bytes allowed per submission. Shorten an Other answer or
                  skip a question.
                </p>
              )}
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
        <footer>
          {step > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                move(step - 1);
              }}
            >
              Back
            </button>
          )}
          <span />
          {row && key !== undefined ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setChoices((previous) => ({ ...previous, [key]: undefined }));
                  move(step + 1);
                }}
              >
                Skip
              </button>
              <button
                type="button"
                className="decision-primary"
                disabled={row.status !== "open" || !usableChoice(choice)}
                onClick={() => {
                  move(step + 1);
                }}
              >
                Next
              </button>
            </>
          ) : (
            <button
              type="button"
              className="decision-primary"
              disabled={busy || !answers.length || oversized}
              onClick={() => {
                void submit();
              }}
            >
              Submit {answers.length} {answers.length === 1 ? "answer" : "answers"}
            </button>
          )}
        </footer>
      </div>
    </dialog>
  );
}
