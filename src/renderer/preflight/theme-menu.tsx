import { type KeyboardEvent, useId, useRef, useState } from "react";

/** The same keyboard-accessible theme menu in Settings and the first-run rail. */
export function ThemeMenu({
  label,
  selected,
  choices,
  onChange,
}: {
  label: string;
  selected: string;
  choices: readonly { id: string; name: string; custom?: boolean }[];
  onChange: (id: string) => void;
}) {
  const id = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const searchRef = useRef({ text: "", time: 0 });
  const typeahead = (event: KeyboardEvent) => {
    if (
      event.key.length !== 1 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.nativeEvent.isComposing
    )
      return;
    const now = Date.now();
    const previous =
      openRef.current && now - searchRef.current.time < 700 ? searchRef.current.text : "";
    // Space still activates an option unless it continues a typed family name.
    if (event.key === " " && !previous) return;
    event.preventDefault();
    if (!openRef.current) triggerRef.current?.click();
    const text = (previous + event.key.toLocaleLowerCase()).slice(-256);
    searchRef.current = { text, time: now };
    const cycling = Array.from(text).every((character) => character === text[0]);
    const prefix = cycling ? (text[0] ?? "") : text;
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    const current = buttons.findIndex((button) => button === document.activeElement);
    // A longer prefix refines the current match; a single letter cycles forward.
    const start = current + (cycling ? 1 : 0);
    for (let offset = 0; offset < buttons.length; offset++) {
      const index = (Math.max(0, start) + offset) % buttons.length;
      if (choices[index]?.name.toLocaleLowerCase().startsWith(prefix)) {
        buttons[index]?.focus();
        break;
      }
    }
  };
  return (
    <div className="theme-menu">
      <span id={`${id}-label`}>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        aria-labelledby={`${id}-label ${id}-value`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.currentTarget.click();
          } else {
            typeahead(event);
          }
        }}
        onClick={() => {
          const node = menuRef.current;
          const anchor = triggerRef.current;
          if (!node || !anchor) return;
          if (openRef.current) {
            node.hidePopover();
            return;
          }
          searchRef.current = { text: "", time: 0 };
          const rect = anchor.getBoundingClientRect();
          node.style.left = `${String(Math.max(8, Math.min(rect.left, window.innerWidth - 292)))}px`;
          node.togglePopover();
          const height = node.getBoundingClientRect().height;
          const top = Math.max(
            8,
            rect.bottom + height + 12 <= window.innerHeight
              ? rect.bottom + 4
              : rect.top - height - 4,
          );
          node.style.top = `${String(top)}px`;
          node.style.maxHeight = `${String(window.innerHeight - top - 8)}px`;
          const selectedOption =
            node.querySelector<HTMLElement>('[aria-checked="true"]') ??
            node.querySelector<HTMLElement>("button");
          selectedOption?.focus();
        }}
      >
        <span id={`${id}-value`}>
          {choices.find((choice) => choice.id === selected)?.name ?? "Custom theme"}
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      <div
        id={id}
        ref={menuRef}
        popover="auto"
        role="menu"
        aria-label={label}
        className="theme-menu-options"
        onBeforeToggle={(event) => {
          // Native toggle is queued; rapid typing needs visibility synchronously.
          openRef.current = event.newState === "open";
        }}
        onToggle={(event) => {
          openRef.current = event.newState === "open";
          setOpen(event.newState === "open");
        }}
        onKeyDown={(event) => {
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
          );
          const index = buttons.findIndex((button) => button === document.activeElement);
          const next =
            event.key === "ArrowDown"
              ? (index + 1) % buttons.length
              : event.key === "ArrowUp"
                ? (index - 1 + buttons.length) % buttons.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : undefined;
          if (next !== undefined) {
            searchRef.current = { text: "", time: 0 };
            event.preventDefault();
            buttons[next]?.focus();
          } else {
            typeahead(event);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            menuRef.current?.hidePopover();
            triggerRef.current?.focus();
          }
        }}
      >
        {choices.map((choice, index) => (
          <div key={choice.id} role="none">
            {choice.custom && !choices[index - 1]?.custom && (
              <hr role="separator" className="theme-divider" />
            )}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={selected === choice.id}
              onClick={() => {
                onChange(choice.id);
                menuRef.current?.hidePopover();
                triggerRef.current?.focus();
              }}
            >
              <span className="theme-check" aria-hidden="true">
                {selected === choice.id ? "✓" : ""}
              </span>
              <span>{choice.name}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
