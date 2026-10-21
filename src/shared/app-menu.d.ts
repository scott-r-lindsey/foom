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
export interface AppVersion {
  app: string;
  electron: string;
}
export type LegalDocument = "licenses" | "notices";
export interface AppMenuApi {
  legal: (id: LegalDocument) => Promise<string>;
  onLegal: (callback: (id: LegalDocument) => void) => () => void;
  version: () => Promise<AppVersion>;
  readonly platform: string;
  setView: (state: {
    available: boolean;
    configAvailable?: boolean;
    maximized: boolean;
    sidebarCollapsed?: boolean;
    tiles: number;
  }) => Promise<void>;
  commands: () => Promise<AppMenuEntry[]>;
  shortcuts: () => Promise<ShortcutGroup[]>;
  execute: (id: string) => Promise<void>;
  onOpen: (callback: () => void) => () => void;
  onShortcuts: (callback: () => void) => () => void;
  onSession: (callback: (id: string, background?: boolean) => void) => () => void;
}
