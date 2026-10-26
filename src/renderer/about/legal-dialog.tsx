import { restoreBoardFocus } from "../board/focus-restore";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppMenuApi, LegalDocument } from "../../shared/app-menu";

export function LegalDialog({
  id,
  menu,
  close,
}: {
  id: LegalDocument;
  menu: AppMenuApi;
  close: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);
  const title = id === "licenses" ? "Licenses" : "Third-party notices";
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const element = dialogRef.current;
    element?.showModal();
    let active = true;
    void menu.legal(id).then(
      (value) => {
        if (active) setText(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
      element?.close();
      restoreBoardFocus(previous);
    };
  }, [id, menu]);
  const dismiss = () => {
    dialogRef.current?.close();
    close();
  };
  return createPortal(
    <dialog
      ref={dialogRef}
      className="about-dialog legal-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          dismiss();
      }}
    >
      <header className="legal-header">
        <h2>{title}</h2>
      </header>
      <pre
        className="legal-text"
        role="region"
        tabIndex={0}
        aria-label={title}
        aria-busy={!text && !failed}
      >
        {failed ? "Unable to read bundled notices." : text}
      </pre>
      <footer className="about-footer">
        <button type="button" onClick={dismiss}>
          Close
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
