import type { ShellView } from "./shell.d";
export interface TerminalFocusRestoration {
  readonly from: Element | null;
}
export interface TerminalViewSource {
  mount(element: HTMLElement): () => void;
  open(id: string): Promise<void>;
  hide(): Promise<void>;
  focus(restoration?: TerminalFocusRestoration): void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ShellView;
}
