import { TerminalMenu } from "../terminal/terminal-menu";
import type { TerminalContextMenu } from "../terminal/terminal-view-source.d";
import { useCallback, useEffect, useState, useRef } from "react";
import type { SetupSource } from "./setup-source.d";

/** The existing human-owned PTY, attached to this Settings window only. */
export function HostTerminal({
  id,
  source,
  finished,
  label = "Install terminal",
  activeLabel = "Installing…",
  collapseOnExit = false,
  showExitStatus = true,
  reveal = false,
}: {
  label?: string;
  activeLabel?: string;
  collapseOnExit?: boolean;
  showExitStatus?: boolean;
  reveal?: boolean;
  id: string;
  source: NonNullable<SetupSource["hostTerminal"]>;
  finished: (id: string) => void | Promise<void>;
}) {
  const [view] = useState(() => source.createView());
  const [menu, setMenu] = useState<TerminalContextMenu>();
  useEffect(() => view.onContextMenu?.(setMenu), [view]);
  const [exit, setExit] = useState<{ exited: boolean; code?: number }>({ exited: false });
  const [observed, setObserved] = useState(false);
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const mount = useCallback(
    (element: HTMLDivElement | null) => (element ? view.mount(element) : undefined),
    [view],
  );
  const visible = !dismissed && !(collapseOnExit && exit.exited);
  useEffect(() => {
    let current = true;
    if (visible && observed)
      void view.open(id).then(() => {
        if (!current) return;
        const attached = !view.getSnapshot().toggleDisabled;
        setReady(attached);
        if (attached && reveal) panelRef.current?.scrollIntoView({ block: "start" });
      });
    return () => {
      current = false;
      void view.hide();
    };
  }, [view, id, visible, observed, reveal]);
  const completedRef = useRef<string | undefined>(undefined);
  const observeExit = useCallback(
    (next: { exited: boolean; code?: number }) => {
      if (completedRef.current === id) return;
      setExit(next);
      setObserved(true);
      if (next.exited) {
        completedRef.current = id;
        void finished(id);
      }
    },
    [id, finished],
  );
  useEffect(() => source.observe(id, observeExit), [source, id, observeExit]);
  if (dismissed || (exit.exited && !showExitStatus)) return null;
  return (
    <section
      ref={panelRef}
      className="host-terminal"
      aria-label={label}
      aria-busy={visible && !ready}
    >
      <header>
        <span
          role="status"
          className={exit.exited && exit.code !== 0 ? "hosts-failure" : undefined}
        >
          {exit.exited
            ? exit.code === 0
              ? "Done"
              : `Failed · exit code ${String(exit.code ?? "unknown")}`
            : activeLabel}
        </span>
        {!exit.exited && source.stop && (
          <button
            type="button"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              setStopFailed(false);
              void view
                .hide()
                .then(() => source.stop?.(id))
                .then(
                  () => {
                    if (!showExitStatus) observeExit({ exited: true });
                  },
                  () => {
                    setStopFailed(true);
                    setStopping(false);
                    void view.open(id);
                  },
                );
            }}
          >
            Stop
          </button>
        )}
        {exit.exited && (
          <button
            type="button"
            onClick={() => {
              setDismissed(true);
            }}
          >
            Dismiss
          </button>
        )}
      </header>
      {stopFailed && <p role="alert">Unable to stop setup. Try again.</p>}
      {visible && <div className="host-terminal-view" ref={mount} />}
      {visible && menu?.id === id && (
        <TerminalMenu
          menu={menu}
          close={() => {
            setMenu(undefined);
          }}
        />
      )}
    </section>
  );
}
