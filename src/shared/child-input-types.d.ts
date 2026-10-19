import type { CHILD_KEYS } from "./child-input";

export type ChildKey = keyof typeof CHILD_KEYS;
export type ChildInput = { kind: "prompt"; text: string } | { kind: "keys"; keys: ChildKey[] };
