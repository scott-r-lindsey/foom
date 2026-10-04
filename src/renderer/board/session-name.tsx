import { useCallback, useEffect, useRef, useState } from "react";
import { Highlight } from "./text-highlight";
export function SessionName({
  name,
  filter,
  save,
  open,
}: {
  name: string;
  filter: string;
  save: (name: string) => void;
  open?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const finishedRef = useRef(false);
  const nameRef = useRef<HTMLSpanElement>(null);
  const clickRef = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(clickRef.current);
    },
    [],
  );
  useEffect(() => {
    const row = nameRef.current?.closest(".board-row");
    const edit = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key === "F2") {
        event.preventDefault();
        window.clearTimeout(clickRef.current);
        finishedRef.current = false;
        setDraft(name);
        setEditing(true);
      }
    };
    row?.addEventListener("keydown", edit);
    return () => {
      row?.removeEventListener("keydown", edit);
    };
  }, [name]);
  const inputRef = useCallback((element: HTMLInputElement | null) => {
    element?.focus();
    element?.select();
  }, []);
  const commit = () => {
    if (!finishedRef.current) {
      finishedRef.current = true;
      save(draft);
      setEditing(false);
    }
  };
  if (editing)
    return (
      <input
        className="session-rename"
        aria-label="Session name"
        maxLength={120}
        value={draft}
        ref={inputRef}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            finishedRef.current = true;
            setEditing(false);
          }
        }}
      />
    );
  return (
    <span
      ref={nameRef}
      className="session-name"
      onClick={(event) => {
        event.stopPropagation();
        window.clearTimeout(clickRef.current);
        // Distinguish opening a session from editing its name. A queued terminal
        // attachment must not steal focus from the inline editor on double-click.
        if (event.detail < 2)
          clickRef.current = window.setTimeout(() => {
            open?.();
          }, 250);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        window.clearTimeout(clickRef.current);
        finishedRef.current = false;
        setDraft(name);
        setEditing(true);
      }}
    >
      <Highlight text={name} filter={filter} />
    </span>
  );
}
