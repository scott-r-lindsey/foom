import { useEffect, useState } from "react";

/** The value and its trailing glyph are one keyboard-accessible copy target. */
export function CopyValue({
  value,
  label = "Copy path",
  copy,
}: {
  value: string;
  label?: string;
  copy: () => Promise<unknown>;
}) {
  const [copied, setCopied] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(0);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  return (
    <>
      <button
        type="button"
        className="copy-value"
        aria-label={label}
        data-copied={Boolean(copied)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void copy().then(
            () => {
              setFailed(false);
              setCopied((value) => value + 1);
            },
            () => {
              setCopied(0);
              setFailed(true);
            },
          );
        }}
      >
        <span className="copy-text">{value}</span>
        <svg
          className="copy-glyph"
          viewBox="0 0 16 16"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
        >
          <path d={copied ? "M3 8.5l3 3 7-7" : "M5.5 5.5h8v8h-8zM10.5 3V2.5h-8v8H3"} />
        </svg>
      </button>
      <span role="status">{failed ? "Unable to copy" : ""}</span>
    </>
  );
}
