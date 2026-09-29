import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createShell } from "./shell-controller";
import type { ShellView } from "./shell.d";
import { Board } from "./board-view";
import { createSampleSource } from "./board-source";

export function Shell() {
  const toggleRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<ReturnType<typeof createShell> | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [source] = useState(createSampleSource);
  const [view, setView] = useState<ShellView>({
    status: "Starting shell…",
    toggleLabel: "Open terminal",
    visible: false,
    toggleDisabled: true,
    restartDisabled: true,
  });
  const mountTerminal = useCallback((element: HTMLElement | null) => {
    if (element) shellRef.current = createShell(element, setView);
    else {
      shellRef.current?.dispose();
      shellRef.current = null;
    }
  }, []);
  useLayoutEffect(() => {
    if (!view.visible && !view.toggleDisabled) toggleRef.current?.focus();
  }, [view.visible, view.toggleDisabled]);
  return (
    <>
      <header>
        <strong>foom</strong>
        <span id="status" role="status">
          {view.status}
        </span>
        <button
          id="toggle-terminal"
          ref={toggleRef}
          aria-controls="terminal"
          aria-expanded={view.visible}
          disabled={view.toggleDisabled}
          onClick={() => {
            void shellRef.current?.toggle();
          }}
        >
          {view.toggleLabel}
        </button>
        <button
          onClick={() => {
            dialogRef.current?.showModal();
            dialogRef.current
              ?.querySelector<HTMLButtonElement>('.board-row[aria-current="true"]')
              ?.focus();
          }}
        >
          Sample board
        </button>
        <button
          id="restart"
          disabled={view.restartDisabled}
          onClick={() => {
            void shellRef.current?.restart();
          }}
        >
          Restart shell
        </button>
      </header>
      <main id="terminal" aria-label="Terminal" ref={mountTerminal} />
      <Board source={source} dialogRef={dialogRef} />
    </>
  );
}
