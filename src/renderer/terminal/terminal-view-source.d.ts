import type { ShellView } from "./shell.d";
export interface TerminalFocusRestoration {
  readonly from: Element | null;
  readonly generation: number;
}
export interface TerminalContextMenu {
  id: string;
  anchor: HTMLElement;
  point: { x: number; y: number };
  copy: (() => void | Promise<void>) | undefined;
  paste: () => void | Promise<void>;
  selectAll: () => void;
  clear: () => void;
}
export interface TerminalViewSource {
  onContextMenu?(listener: (menu: TerminalContextMenu) => void): () => void;
  mount(element: HTMLElement): () => void;
  open(id: string): Promise<void>;
  hide(): Promise<void>;
  focus(restoration?: TerminalFocusRestoration): void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ShellView;
}
