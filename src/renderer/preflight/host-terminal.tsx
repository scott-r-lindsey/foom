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
}: {
  label?: string;
  activeLabel?: string;
  id: string;
  source: NonNullable<SetupSource["hostTerminal"]>;
  finished: (id: string) => void | Promise<void>;
}) {
  const [view] = useState(() => source.createView());
  const [menu, setMenu] = useState<TerminalContextMenu>();
  useEffect(() => view.onContextMenu?.(setMenu), [view]);
  const [exit, setExit] = useState<{ exited: boolean; code?: number }>({ exited: false });
  const [observed, setObserved] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const mount = useCallback(
    (element: HTMLDivElement | null) => (element ? view.mount(element) : undefined),
    [view],
  );
  useEffect(() => {
    if (!dismissed && observed) void view.open(id);
    return () => {
      void view.hide();
    };
  }, [view, id, dismissed, observed]);
  const completedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    return source.observe(id, (next) => {
      setExit(next);
      setObserved(true);
      if (next.exited && completedRef.current !== id) {
        completedRef.current = id;
        void finished(id);
      }
    });
  }, [source, id, finished]);
  if (dismissed) return null;
  return (
    <section className="host-terminal" aria-label={label}>
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
      <div className="host-terminal-view" ref={mount} />
      {menu?.id === id && (
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
