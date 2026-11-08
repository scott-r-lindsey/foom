// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HostTerminal } from "../../../../src/renderer/preflight/host-terminal";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import type { TerminalContextMenu } from "../../../../src/renderer/terminal/terminal-view-source.d";
import type { TerminalViewSource } from "../../../../src/renderer/terminal/terminal-view-source.d";
afterEach(cleanup);

test.each([0, 17, undefined])(
  "recipe keeps its terminal until dismissed and reports exit %s outside output",
  (code) => {
    const dispose = vi.fn();
    const off = vi.fn();
    const open = vi.fn(async () => {});
    const hide = vi.fn(async () => {});
    let context = (_menu: TerminalContextMenu) => {};
    const paste = vi.fn();
    const view: TerminalViewSource = {
      onContextMenu: (listener) => {
        context = listener;
        return () => {};
      },
      mount: vi.fn(() => dispose),
      open,
      hide,
      focus: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getSnapshot: () => ({
        status: "",
        state: "quiet_ok",
        visible: true,
        attaching: false,
        toggleLabel: "",
        toggleDisabled: false,
        restartDisabled: false,
      }),
    };
    let observe: (exit: { exited: boolean; code?: number }) => void = () => {};
    const source: NonNullable<SetupSource["hostTerminal"]> = {
      createView: () => view,
      observe: (_id, listener) => {
        observe = listener;
        return off;
      },
    };
    const finished = vi.fn();
    const result = render(<HostTerminal id="recipe-1" source={source} finished={finished} />);
    expect(screen.getByRole("status").textContent).toBe("Installing…");
    expect(open).not.toHaveBeenCalled();
    act(() => {
      observe({ exited: false });
    });
    expect(open).toHaveBeenCalledWith("recipe-1");
    act(() => {
      context({
        id: "recipe-1",
        anchor: screen.getByRole("region", { name: "Install terminal" }),
        point: { x: 0, y: 0 },
        copy: undefined,
        paste,
        selectAll: () => {},
        clear: () => {},
      });
    });
    const menu = screen.getByRole("menu", { name: "Terminal menu" });
    expect(within(menu).queryByText("Split")).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste" }));
    expect(paste).toHaveBeenCalledOnce();
    act(() => {
      observe({ exited: true, ...(code === undefined ? {} : { code }) });
    });
    expect(screen.getByRole("status").textContent).toBe(
      code === 0 ? "Done" : `Failed · exit code ${String(code ?? "unknown")}`,
    );
    act(() => {
      observe({ exited: true });
    });
    expect(finished).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region")).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    result.unmount();
    expect(off).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalled();
  },
);
