import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import type { TerminalContextMenu } from "../../../../src/renderer/terminal/terminal-view-source.d";
import type { ShellView } from "../../../../src/renderer/terminal/shell";
import type { BoardCommand } from "../../../../src/shared/board-command";
import { boardRows as sampleRows } from "../../../fixtures/board";

export function registerTileAreaFixture() {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });
}

export function setup(snapshotOverrides: Partial<ShellView> = {}) {
  const snapshot: ShellView = {
    status: "Terminal",
    cols: 80,
    rows: 24,
    state: "quiet_ok",
    visible: true,
    firstFrame: true,
    attaching: false,
    toggleLabel: "Hide terminal",
    toggleDisabled: false,
    restartDisabled: true,
    ...snapshotOverrides,
  };
  const data = createSampleSource(
    sampleRows(100)
      .slice(0, 5)
      .map((row) => ({ ...row, kind: "agent" as const, managed: true })),
  );
  let command: ((command: BoardCommand) => void) | undefined;
  const views: {
    mount: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    context: (menu: TerminalContextMenu) => void;
  }[] = [];
  const source: BoardSource = {
    ...data,
    subscribeCommands: (listener) => {
      command = listener;
      return () => {
        command = undefined;
      };
    },
    createView: () => {
      let element: HTMLElement | undefined;
      let contextMenu: ((menu: TerminalContextMenu) => void) | undefined;
      const view = {
        context: (menu: TerminalContextMenu) => {
          contextMenu?.(menu);
        },
        onContextMenu: (listener: (menu: TerminalContextMenu) => void) => {
          contextMenu = listener;
          return () => {
            contextMenu = undefined;
          };
        },
        mount: vi.fn((node: HTMLElement) => {
          element = node;
          return view.dispose;
        }),
        dispose: vi.fn(),
        open: vi.fn(() => Promise.resolve()),
        hide: vi.fn(() => Promise.resolve()),
        focus: vi.fn(() => {
          element?.closest<HTMLElement>(".terminal-tile")?.focus();
        }),
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
      };
      views.push(view);
      return view;
    },
  };
  const screen = render(<Board source={source} />);
  const send = (value: BoardCommand) => {
    act(() => {
      command?.(value);
    });
  };
  const row = (index: number) =>
    screen.container.querySelectorAll<HTMLElement>(".board-row")[index] ?? document.body;
  const click = (index: number) => fireEvent.click(row(index));
  return { screen, data, views, source, send, row, click, snapshot };
}
