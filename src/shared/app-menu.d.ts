/** Serializable projection of main's command registry; never executable renderer data. */
export interface CommandItem {
  id: string;
  label: string;
  section: string;
  shortcut: string;
  enabled: boolean;
  checked?: boolean;
}
export interface AppMenuApi {
  readonly platform: string;
  setView: (state: { available: boolean; maximized: boolean; tiles: number }) => Promise<void>;
  commands: () => Promise<CommandItem[]>;
  execute: (id: string) => Promise<void>;
  onOpen: (callback: () => void) => () => void;
  onSession: (callback: (id: string) => void) => () => void;
}
