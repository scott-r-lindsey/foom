import { copyableErrorId } from "../../shared/application-errors";
import type { CopyableErrorId } from "../../shared/application-error";
import { CopyValue } from "../ui/copy-value";
import { restoreBoardFocus } from "./focus-restore";
import { createContext, useCallback, use, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

type Failure = { operation: string; message: string; row?: string };
type BackgroundErrors = {
  failures: readonly Failure[];
  report: (operation: string, message: string, row?: string) => void;
  clear: (operation: string) => void;
};
const fallback: BackgroundErrors = {
  failures: [],
  report: () => {},
  clear: () => {},
};
const BackgroundContext = createContext<BackgroundErrors | undefined>(undefined);

const CopyErrorContext = createContext<((id: CopyableErrorId) => Promise<unknown>) | undefined>(
  undefined,
);
export function ErrorPresentation({
  children,
  copyError,
}: {
  children: ReactNode;
  copyError?: ((id: CopyableErrorId) => Promise<unknown>) | undefined;
}) {
  const parent = use(BackgroundContext);
  return (
    <CopyErrorContext value={copyError ?? use(CopyErrorContext)}>
      {parent ? children : <ErrorPresentationState>{children}</ErrorPresentationState>}
    </CopyErrorContext>
  );
}
function ErrorPresentationState({ children }: { children: ReactNode }) {
  const [failures, setFailures] = useState<readonly Failure[]>([]);
  const report = useCallback((operation: string, message: string, row?: string) => {
    setFailures((current) => [
      ...current.filter((failure) => failure.operation !== operation),
      { operation, message, ...(row ? { row } : {}) },
    ]);
  }, []);
  const clear = useCallback((operation: string) => {
    setFailures((current) => {
      const next = current.filter((failure) => failure.operation !== operation);
      return next.length === current.length ? current : next;
    });
  }, []);
  return <BackgroundContext value={{ failures, report, clear }}>{children}</BackgroundContext>;
}

export const useBackgroundErrors = () => use(BackgroundContext) ?? fallback;

/** Never mounts a dialog: publication alone cannot move terminal focus. */
export function BackgroundErrorMark({ row }: { row?: string }) {
  const { failures, clear } = useBackgroundErrors();
  const [expanded, setExpanded] = useState(false);
  const matching = failures.filter((failure) => failure.row === row);
  if (!matching.length) return null;
  return (
    <span className="background-error" data-expanded={expanded}>
      <button
        type="button"
        className="failure-mark"
        aria-label="Show failure"
        onClick={() => {
          setExpanded((value) => !value);
        }}
      >
        ■
      </button>
      <span className="background-error-message" role="status">
        {matching.map((failure) => (
          <span key={failure.operation}>
            {failure.message}
            <button
              type="button"
              onClick={() => {
                clear(failure.operation);
              }}
            >
              Dismiss
            </button>
          </span>
        ))}
      </span>
    </span>
  );
}

// Menus may disappear while an asynchronous action fails. Remember their live anchor.
const focusOrigins = new WeakMap<Element, HTMLElement>();
const menuDismissals = new Set<() => void>();
export function registerErrorFocus(
  element: Element,
  origin: HTMLElement,
  dismiss: () => void,
): () => void {
  focusOrigins.set(element, origin);
  const close = () => {
    dismiss();
  };
  menuDismissals.add(close);
  return () => {
    focusOrigins.delete(element);
    menuDismissals.delete(close);
  };
}
export function captureErrorFocus(): Element | null {
  let target = document.activeElement;
  let element = target;
  while (element) {
    const origin = focusOrigins.get(element);
    if (origin) {
      target = origin;
      element = origin;
    } else element = element.parentElement;
  }
  return target;
}

/** Presentation only; trusted permissions and destructive confirmations stay in main. */
export function ActionError({
  message,
  close,
  fix,
  returnFocus,
}: {
  message: string;
  close: () => void;
  returnFocus?: (() => Element | null) | undefined;
  fix?: { label: string; run: () => void } | undefined;
}) {
  const copyError = use(CopyErrorContext);
  const errorId = copyableErrorId(message);
  const ref = useRef<HTMLDialogElement>(null);
  const messageId = useId();
  const originRef = useRef(returnFocus);
  useEffect(() => {
    const previous = originRef.current?.() ?? captureErrorFocus();
    for (const dismiss of menuDismissals) dismiss();
    const dialog = ref.current;
    dialog?.showModal();
    // showModal otherwise selects its first button. Enter must never select Prune.
    dialog?.focus();
    return () => {
      dialog?.close();
      restoreBoardFocus(previous);
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="action-error"
      tabIndex={-1}
      aria-label="Action failed"
      aria-describedby={messageId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
      }}
    >
      <div className="action-error-message">
        <span className="failure-mark" aria-hidden="true">
          ■
        </span>
        <p id={messageId} role="alert">
          <CopyValue
            value={message}
            label="Copy error text"
            copy={() =>
              errorId && copyError
                ? copyError(errorId)
                : Promise.reject(new Error("Copy unavailable"))
            }
          />
        </p>
      </div>
      <div className="action-error-buttons">
        <button type="button" onClick={close}>
          Dismiss
        </button>
        {fix && (
          <button type="button" onClick={fix.run}>
            {fix.label}
          </button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
