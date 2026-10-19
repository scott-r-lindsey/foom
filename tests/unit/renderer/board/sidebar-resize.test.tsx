// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  SidebarResize,
  clampSidebarWidth,
  sidebarMaxWidth,
} from "../../../../src/renderer/board/sidebar-resize";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture(width = 300) {
  const save = vi.fn();
  const onDrag = vi.fn();
  function View({ enabled }: { enabled: boolean }) {
    const sidebarRef = useRef<HTMLElement>(null);
    const [value, setValue] = useState(width);
    return (
      <aside ref={sidebarRef}>
        <SidebarResize
          sidebarRef={sidebarRef}
          width={value}
          save={(next) => {
            save(next);
            setValue(next);
          }}
          onDrag={onDrag}
          enabled={enabled}
        />
      </aside>
    );
  }
  const view = render(<View enabled />);
  const handle = view.getByRole("separator");
  Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
  return { ...view, handle, save, onDrag, View };
}
function pointer(
  type: string,
  target: Element,
  values: { button?: number; pointerId?: number; clientX?: number } = {},
) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { button: 0, pointerId: 1, clientX: 300, ...values });
  fireEvent(target, event);
}
test("width clamps to a usable header and 40% without modifying saved width", () => {
  vi.stubGlobal("innerWidth", 1200);
  expect(sidebarMaxWidth(500)).toBe(240);
  expect(clampSidebarWidth(100, 1200)).toBe(240);
  expect(clampSidebarWidth(600, 1200)).toBe(480);
  const f = fixture(450);
  expect(f.handle.getAttribute("aria-valuenow")).toBe("450");
  expect(f.container.querySelector("aside")?.style.getPropertyValue("--sidebar-width")).toBe(
    "450px",
  );
  vi.stubGlobal("innerWidth", 800);
  fireEvent(window, new Event("resize"));
  expect(f.handle.getAttribute("aria-valuenow")).toBe("320");
  vi.stubGlobal("innerWidth", 1400);
  fireEvent(window, new Event("resize"));
  expect(f.handle.getAttribute("aria-valuenow")).toBe("450");
  expect(f.save).not.toHaveBeenCalled();
});
test("keyboard steps, limits and double-click reset expose current dimensions", () => {
  vi.stubGlobal("innerWidth", 1200);
  const f = fixture();
  for (const [key, expected] of [
    ["ArrowLeft", 290],
    ["ArrowRight", 300],
    ["Home", 240],
    ["End", 480],
  ] as const) {
    fireEvent.keyDown(f.handle, { key });
    expect(f.save).toHaveBeenLastCalledWith(expected);
    expect(f.handle.getAttribute("aria-valuenow")).toBe(String(expected));
  }
  fireEvent.keyDown(f.handle, { key: "Enter" });
  expect(f.save).toHaveBeenCalledTimes(4);
  fireEvent.doubleClick(f.handle);
  expect(f.save).toHaveBeenLastCalledWith(300);
});
test("pointer capture resizes live and saves once on release or cancellation", () => {
  vi.stubGlobal("innerWidth", 1200);
  const f = fixture();
  const sidebar = f.container.querySelector("aside");
  pointer("pointermove", f.handle);
  pointer("pointerdown", f.handle, { button: 2 });
  expect(f.onDrag).not.toHaveBeenCalled();
  pointer("pointerdown", f.handle);
  pointer("pointerdown", f.handle);
  expect(f.onDrag).toHaveBeenCalledExactlyOnceWith(true);
  pointer("pointermove", f.handle, { clientX: 400, pointerId: 2 });
  pointer("pointermove", f.handle, { clientX: 400 });
  expect(sidebar?.style.getPropertyValue("--sidebar-width")).toBe("400px");
  expect(sidebar?.dataset["resizing"]).toBe("true");
  expect(f.save).not.toHaveBeenCalled();
  pointer("pointerup", f.handle);
  pointer("lostpointercapture", f.handle);
  expect(f.save).toHaveBeenCalledExactlyOnceWith(400);
  expect(sidebar?.dataset["resizing"]).toBeUndefined();
  expect(f.onDrag).toHaveBeenLastCalledWith(false);
  pointer("pointerdown", f.handle);
  pointer("pointermove", f.handle, { clientX: -100 });
  pointer("pointercancel", f.handle);
  expect(f.save).toHaveBeenLastCalledWith(240);
  pointer("pointerdown", f.handle);
  pointer("lostpointercapture", f.handle);
  f.rerender(<f.View enabled={false} />);
  expect(f.queryByRole("separator")).toBeNull();
});
test("unmounting while captured clears the resize flag and signals terminal refit", () => {
  const f = fixture();
  pointer("pointerdown", f.handle);
  const sidebar = f.container.querySelector("aside");
  const end = vi.fn();
  sidebar?.addEventListener("sidebar-resize-end", end);
  f.unmount();
  expect(sidebar?.dataset["resizing"]).toBeUndefined();
  expect(end).toHaveBeenCalledOnce();
  expect(f.onDrag).toHaveBeenLastCalledWith(false);
});

test("release applies the final width before signalling terminal refit when pointer updates batch", () => {
  vi.stubGlobal("innerWidth", 1200);
  const f = fixture();
  const sidebar = f.container.querySelector("aside");
  const widths: (string | undefined)[] = [];
  sidebar?.addEventListener("sidebar-resize-end", () => {
    widths.push(sidebar.style.getPropertyValue("--sidebar-width"));
  });
  act(() => {
    pointer("pointerdown", f.handle);
    pointer("pointermove", f.handle, { clientX: 400 });
    pointer("pointerup", f.handle);
  });
  expect(widths).toEqual(["400px"]);
});
