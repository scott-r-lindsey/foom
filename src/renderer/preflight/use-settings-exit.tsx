import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionError } from "../board/error-presentation";
import { restoreBoardFocus } from "../board/focus-restore";
import type { SetupSource } from "./setup-source.d";

/** Navigation only. Native window close and quit keep their existing main-owned gate. */
export function useSettingsExit(installs: SetupSource["installs"]) {
  const continuationRef = useRef<(() => void) | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);
  const finish = useCallback(async () => {
    try {
      await installs?.close();
      const proceed = continuationRef.current;
      continuationRef.current = undefined;
      setAsking(false);
      proceed?.();
    } catch {
      continuationRef.current = undefined;
      setAsking(false);
      setFailed(true);
    }
  }, [installs]);
  const leave = useCallback(
    (proceed: () => void) => {
      if (continuationRef.current) return;
      setFailed(false);
      if (!installs?.hasSessions()) {
        proceed();
        return;
      }
      continuationRef.current = proceed;
      void installs
        .running()
        .then((running) => {
          if (running) setAsking(true);
          else void finish();
        })
        .catch(() => {
          continuationRef.current = undefined;
          setFailed(true);
        });
    },
    [installs, finish],
  );
  return {
    leave,
    dialog: asking ? (
      <StopInstallDialog
        stop={() => {
          void finish();
        }}
        keep={() => {
          continuationRef.current = undefined;
          setAsking(false);
        }}
      />
    ) : failed ? (
      <ActionError
        message="Unable to close install."
        close={() => {
          setFailed(false);
        }}
      />
    ) : null,
  };
}

function StopInstallDialog({ stop, keep }: { stop: () => void; keep: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialogRef.current;
    element?.showModal();
    keepRef.current?.focus();
    return () => {
      element?.close();
      restoreBoardFocus(previous);
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialogRef}
      className="stop-install-dialog"
      aria-label="Stop the install?"
      onCancel={(event) => {
        event.preventDefault();
        if (!stopping) keep();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
      }}
    >
      <h2>Stop the install?</h2>
      <footer>
        <button
          type="button"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            stop();
          }}
        >
          Stop
        </button>
        <button type="button" ref={keepRef} disabled={stopping} onClick={keep}>
          Keep open
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
