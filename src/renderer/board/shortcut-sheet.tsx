import { useEffect, useRef } from "react";
import type { ShortcutGroup } from "../../shared/app-menu";
/** Main's shortcut sheet in columns. Escape or a click outside closes it. */
export function ShortcutSheet({
  groups,
  close,
}: {
  groups: readonly ShortcutGroup[];
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Leave the modal state first: elements outside an open modal dialog can't take focus.
  const dismiss = () => {
    ref.current?.close();
    close();
  };
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="shortcut-sheet"
      aria-labelledby="shortcut-sheet-title"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        // The dialog itself is only hit through its backdrop; content sits in the inner div.
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div className="shortcut-sheet-body">
        <h2 id="shortcut-sheet-title">Keyboard shortcuts</h2>
        <div className="shortcut-columns">
          {groups.map((group) => (
            <section key={group.title} aria-labelledby={`shortcuts-${group.title}`}>
              <h3 id={`shortcuts-${group.title}`}>
                {group.title}
                {group.lead && <span className="shortcut-lead">{group.lead}</span>}
              </h3>
              <dl>
                {group.rows.map((row) => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>
                      <kbd>{row.keys}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </dialog>
  );
}
