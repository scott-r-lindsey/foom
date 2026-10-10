/** Serializable projection of main's command registry; never executable renderer data. */
export interface CommandItem {
  id: string;
  label: string;
  shortcut: string;
  enabled: boolean;
  checked?: boolean;
  /** Agent badge mark, for entries that name an agent. */
  badge?: string;
}
/** One stop in the wordmark menu. `null` is a separator. */
export type AppMenuEntry =
  | null
  | ({ kind: "command" } & CommandItem)
  | { kind: "submenu"; id: string; label: string; items: readonly (CommandItem | null)[] }
  | { kind: "size"; label: string; scale: number; smaller: CommandItem; bigger: CommandItem };
export interface ShortcutRow {
  label: string;
  keys: string;
}
/** One column of the keyboard shortcut sheet; `lead` is a key prefix shared by every row. */
export interface ShortcutGroup {
  title: string;
  lead: string;
  rows: readonly ShortcutRow[];
}
export interface AppMenuApi {
  readonly platform: string;
  setView: (state: { available: boolean; maximized: boolean; tiles: number }) => Promise<void>;
  commands: () => Promise<AppMenuEntry[]>;
  shortcuts: () => Promise<ShortcutGroup[]>;
  execute: (id: string) => Promise<void>;
  onOpen: (callback: () => void) => () => void;
  onShortcuts: (callback: () => void) => () => void;
  onSession: (callback: (id: string) => void) => () => void;
}
