import type { ChildInput } from "./child-input-types";
export type { ChildInput, ChildKey } from "./child-input-types";

/** Logical child input is validated again by the utility host before any PTY write. */
export const CHILD_KEYS = {
  enter: "\r",
  esc: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  tab: "\t",
  "ctrl+c": "\x03",
  y: "y",
  n: "n",
  "0": "0",
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
} as const;

export function isChildInput(value: unknown): value is ChildInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields: Record<string, unknown> = { ...value };
  if (Object.keys(fields).length !== 2) return false;
  if (fields["kind"] === "prompt") {
    const text = fields["text"];
    return (
      typeof text === "string" &&
      text.trim().length > 0 &&
      new TextEncoder().encode(text).length <= 16384 &&
      !/[^\P{Cc}\n\t]|\p{Cf}|\p{Zl}|\p{Zp}/u.test(text)
    );
  }
  return (
    fields["kind"] === "keys" &&
    Array.isArray(fields["keys"]) &&
    fields["keys"].length >= 1 &&
    fields["keys"].length <= 64 &&
    Array.from(fields["keys"]).every(
      (key: unknown) => typeof key === "string" && Object.hasOwn(CHILD_KEYS, key),
    )
  );
}

export function childInputBytes(input: ChildInput, bracketedPaste: boolean): string {
  if (!isChildInput(input)) throw new Error("Invalid child input");
  if (input.kind === "keys") return input.keys.map((key) => CHILD_KEYS[key]).join("");
  const text = input.text.replaceAll("\n", "\r");
  return (bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text) + "\r";
}
