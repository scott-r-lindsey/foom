import type { ShellView } from "./shell.d";
export interface TerminalFocusRestoration {
  readonly from: Element | null;
  readonly generation: number;
}
export interface TerminalViewSource {
  mount(element: HTMLElement): () => void;
  open(id: string): Promise<void>;
  hide(): Promise<void>;
  focus(restoration?: TerminalFocusRestoration): void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ShellView;
}
