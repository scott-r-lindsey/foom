import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { AppMenuApi, AppVersion } from "../../shared/app-menu";
import { FlightCanvas, prefersReducedMotion } from "../ui/flight-canvas";
import { Wordmark } from "../ui/wordmark";

export const SCOTT_NOTE =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n\nUt enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

export function AboutDialog({ menu, close }: { menu: AppMenuApi; close: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState(false);
  const [version, setVersion] = useState<AppVersion>();
  const [reduced] = useState(prefersReducedMotion);
  const [position, setPosition] = useState({ left: 0, top: 0, notch: 0 });
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const element = dialogRef.current;
    element?.showModal();
    let active = true;
    void menu.version().then(
      (value) => {
        if (active) setVersion(value);
      },
      () => {},
    );
    return () => {
      active = false;
      element?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [menu]);
  const closeNote = () => {
    setNote(false);
    buttonRef.current?.focus();
  };
  useEffect(() => {
    if (!note) return;
    bubbleRef.current?.focus();
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !bubbleRef.current?.contains(event.target) &&
        !buttonRef.current?.contains(event.target)
      ) {
        setNote(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
    };
  }, [note]);
  const dismiss = () => {
    dialogRef.current?.close();
    close();
  };
  return createPortal(
    <dialog
      ref={dialogRef}
      className="about-dialog"
      aria-label="About Foom"
      onCancel={(event) => {
        event.preventDefault();
        if (note) closeNote();
        else dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && note) {
          event.preventDefault();
          event.stopPropagation();
          closeNote();
        }
      }}
    >
      <div className="about-art">
        <FlightCanvas reduced={reduced} />
        <div className="about-scrim" />
        <div className="about-text">
          <Wordmark />
          <div className="about-by">
            By Scott Lindsey{" "}
            <button
              ref={buttonRef}
              type="button"
              className="about-note-button"
              aria-label="A note from Scott"
              aria-expanded={note}
              aria-controls="scott-note"
              onClick={() => {
                if (note) {
                  closeNote();
                  return;
                }
                const b = buttonRef.current?.getBoundingClientRect(),
                  d = dialogRef.current?.getBoundingClientRect();
                if (b && d) {
                  const top = Math.max(
                    12,
                    Math.min(d.height - 240, b.top - d.top + b.height / 2 - 110),
                  );
                  setPosition({
                    left: b.right - d.left + 12,
                    top,
                    notch: b.top - d.top + b.height / 2 - top,
                  });
                }
                setNote(true);
              }}
            >
              ?
            </button>
          </div>
          <div className="about-version">
            {version && `Version ${version.app} · Electron ${version.electron}`}
          </div>
          <p className="about-voice">Nothing needs you. Yet.</p>
        </div>
      </div>
      {note && (
        <div
          id="scott-note"
          ref={bubbleRef}
          className="row-menu about-note"
          role="dialog"
          aria-label="A note from Scott"
          tabIndex={-1}
          style={
            {
              left: position.left,
              top: position.top,
              "--notch": `${String(position.notch)}px`,
            } as CSSProperties
          }
        >
          {SCOTT_NOTE.split("\n\n").map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          <p className="about-signature">— Scott</p>
        </div>
      )}
      <footer className="about-footer">
        {[
          ["Licenses", "licenses"],
          ["Third-party notices", "notices"],
          ["Source", "github"],
        ].map(([label, id]) => (
          <button
            key={id}
            className="about-link"
            onClick={() => {
              if (id) void menu.execute(id);
            }}
          >
            {label}
          </button>
        ))}
        <button onClick={dismiss}>Close</button>
      </footer>
    </dialog>,
    document.body,
  );
}
