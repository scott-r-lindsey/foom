// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SidebarSessionRow } from "../../../../src/renderer/board/sidebar-session-row";
import { boardRows } from "../../../fixtures/board";

afterEach(cleanup);

test("a restored shell cleanup failure is visible and announced without opening its panel", () => {
  const original = boardRows(0)[0];
  if (!original) throw new Error("Missing row");
  const view = render(
    <SidebarSessionRow
      row={{
        ...original,
        state: "failed",
        kind: "shell",
        agent: "shell",
        exited: true,
        closeFailed: true,
        reason: "Close failed · cleanup may be incomplete",
      }}
      name="Shell"
      identity="Shell"
      parentName={undefined}
      related={false}
      compact={false}
      docked={false}
      now={0}
      filter=""
      tile={undefined}
      otherView={false}
      selected="shell"
      events={{
        onPointerEnter: vi.fn(),
        onPointerLeave: vi.fn(),
        onContextMenu: vi.fn(),
        onKeyDownCapture: vi.fn(),
      }}
      actions={null}
      register={vi.fn()}
      focus={vi.fn()}
      open={vi.fn()}
      rename={vi.fn()}
      onHover={vi.fn()}
      onFocusSession={vi.fn()}
    />,
  );
  expect(view.getByText("Close failed · cleanup may be incomplete")).toBeTruthy();
  expect(view.getByRole("treeitem").getAttribute("aria-label")).toContain("Close failed");
});
