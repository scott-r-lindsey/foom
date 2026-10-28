import type { ShellView } from "./shell.d";
export interface TerminalViewSource {
  mount(element: HTMLElement): () => void;
  open(id: string): Promise<void>;
  hide(): Promise<void>;
  focus(options?: { restore?: boolean }): void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ShellView;
}
