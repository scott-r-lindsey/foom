import { useEffect, useRef, useState } from "react";
import { clampRecentDays } from "../../shared/recent-repositories";
import { useWheelNotch } from "../wheel-notch";

/** An editable day count; wheel changes consume scrolling only over this control. */
export function RecentDaysInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (days: number) => void;
}) {
  const [draft, setDraft] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const wheelNotch = useWheelNotch();
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const direction = wheelNotch(event);
      if (!direction) return;
      const next = clampRecentDays(value + direction);
      setDraft(undefined);
      if (next !== value) onChange(next);
    };
    input.addEventListener("wheel", wheel, { passive: false });
    return () => {
      input.removeEventListener("wheel", wheel);
    };
  }, [value, onChange, wheelNotch]);
  return (
    <input
      ref={inputRef}
      className="recent-days-input"
      aria-label="Recent repository days"
      type="number"
      min={1}
      max={365}
      step={1}
      value={draft ?? String(value)}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const days = Number(text);
        if (text !== "" && Number.isInteger(days) && days >= 1 && days <= 365) onChange(days);
      }}
      onBlur={(event) => {
        const text = event.target.value;
        const next = text === "" ? value : clampRecentDays(Number(text));
        setDraft(undefined);
        if (next !== value) onChange(next);
      }}
    />
  );
}
