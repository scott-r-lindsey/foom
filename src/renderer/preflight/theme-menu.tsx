import { useId, useRef, useState } from "react";

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
        onClick={() => {
          const node = menuRef.current;
          const anchor = triggerRef.current;
          if (!node || !anchor) return;
          if (open) {
            node.hidePopover();
            return;
          }
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
        onToggle={(event) => {
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
            event.preventDefault();
            buttons[next]?.focus();
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
