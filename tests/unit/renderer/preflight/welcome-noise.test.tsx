// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  AGENTS,
  DONE,
  LAYOUT,
  NEEDS_YOU,
  NoiseToCalm,
} from "../../../../src/renderer/preflight/welcome-noise";

import { SidebarRepositorySection } from "../../../../src/renderer/board/sidebar-repository-section";
import { SidebarWorktreeSection } from "../../../../src/renderer/board/sidebar-worktree-section";
import { SidebarSessionRow } from "../../../../src/renderer/board/sidebar-session-row";
import { WelcomeSidebar } from "../../../../src/renderer/preflight/welcome-sidebar";
vi.mock("../../../../src/renderer/board/sidebar-repository-section", { spy: true });
vi.mock("../../../../src/renderer/board/sidebar-worktree-section", { spy: true });
vi.mock("../../../../src/renderer/board/sidebar-session-row", { spy: true });
let reduced = false;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.useFakeTimers();
  reduced = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: reduced }),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tiles = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".noise-tile")];
const stage = (root: HTMLElement) => root.querySelector<HTMLElement>(".welcome-noise");

test("ten terminals fold into lights, then one needs you and one is done", () => {
  const { container } = render(<NoiseToCalm random={() => 0.5} />);
  expect(stage(container)?.getAttribute("data-phase")).toBe("noise");
  expect(stage(container)?.getAttribute("aria-hidden")).toBe("true");
  expect(tiles(container)).toHaveLength(AGENTS.length);
  expect(tiles(container).every((tile) => tile.getAttribute("data-state") === "working")).toBe(
    true,
  );
  // Each terminal starts mid-session with colored output and a status line.
  expect(container.querySelector(".noise-output .tone-accent")).not.toBeNull();
  expect(container.querySelectorAll(".noise-status")).toHaveLength(AGENTS.length);
  expect(container.querySelectorAll(".noise-title .board-agent")).toHaveLength(AGENTS.length);
  expect(container.querySelectorAll(".noise-title .board-light")).toHaveLength(AGENTS.length);
  expect(container.querySelectorAll(".welcome-sidebar .board-agent")).toHaveLength(AGENTS.length);
  expect(container.querySelector(".noise-title")?.textContent).toContain(
    "CClumen-garden › feat/tide-map",
  );
  expect(container.querySelector(".welcome-sidebar .board-row")?.textContent).toContain("Working");
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(stage(container)?.getAttribute("data-phase")).toBe("calm");
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(stage(container)?.getAttribute("data-phase")).toBe("settled");
  const settled = tiles(container);
  expect(settled[NEEDS_YOU]?.getAttribute("data-state")).toBe("needs_input");
  expect(container.querySelector('[data-welcome-session="welcome-3"]')?.textContent).toContain(
    "Needs you",
  );
  expect(settled[DONE]?.getAttribute("data-state")).toBe("done");
  expect(container.querySelector('[data-welcome-session="welcome-7"]')?.textContent).toContain(
    "Done",
  );
  expect(settled.filter((tile) => tile.getAttribute("data-state") === "working")).toHaveLength(8);
});

test("tiles are laid out like a window manager, and lights follow each terminal", () => {
  let seed = 0;
  // A fixed walk through [0, 1) keeps the output varied and the test repeatable.
  const { container } = render(<NoiseToCalm random={() => (seed = (seed + 0.618) % 1)} />);
  const light = (index: number) =>
    Number(tiles(container)[index]?.style.getPropertyValue("--light"));
  const area = LAYOUT.reduce((total, [, , w, h]) => total + w * h, 0);
  expect(area).toBe(100 * 100);
  expect(tiles(container)[0]?.style.getPropertyValue("--w")).toBe(String(LAYOUT[0][2]));
  const seen = new Set<number>();
  for (let tick = 0; tick < 40; tick++) {
    act(() => {
      vi.advanceTimersByTime(70);
    });
    seen.add(light(0));
  }
  expect(seen.size).toBeGreaterThan(3);
  expect([...seen].every((level) => level >= 0.25 && level <= 1)).toBe(true);
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  // Lights that need you or are done hold steady.
  expect(light(NEEDS_YOU)).toBe(1);
  expect(light(DONE)).toBe(1);
});

test("reduced motion shows the settled board and schedules nothing", () => {
  reduced = true;
  const { container } = render(<NoiseToCalm />);
  expect(stage(container)?.getAttribute("data-phase")).toBe("settled");
  expect(tiles(container)[0]?.style.getPropertyValue("--light")).toBe("0.7");
  expect(vi.getTimerCount()).toBe(0);
});

test("unmounting stops the timers", () => {
  const { unmount } = render(<NoiseToCalm />);
  expect(vi.getTimerCount()).toBe(3);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("the illustration uses the real repository, worktree and session presentations with inert handlers", async () => {
  const { container } = render(<NoiseToCalm />);
  expect(SidebarRepositorySection).toHaveBeenCalled();
  expect(SidebarWorktreeSection).toHaveBeenCalled();
  expect(SidebarSessionRow).toHaveBeenCalled();
  expect(container.querySelectorAll(".repository-row")).toHaveLength(2);
  expect(container.querySelectorAll(".worktree-row")).toHaveLength(4);
  expect(container.querySelectorAll(".session-entry")).toHaveLength(10);
  expect(stage(container)?.hasAttribute("inert")).toBe(true);
  expect(container.querySelector(".sidebar-add-repository")?.textContent).toBe("+");
  const repository = vi.mocked(SidebarRepositorySection).mock.calls.at(-1)?.[0];
  const worktree = vi.mocked(SidebarWorktreeSection).mock.calls.at(-1)?.[0];
  const session = vi.mocked(SidebarSessionRow).mock.calls.at(-1)?.[0];
  expect(repository).toBeDefined();
  repository?.toggle();
  worktree?.toggle();
  await worktree?.openPullRequest();
  session?.open(session.row);
  expect(container.querySelectorAll("[role=dialog], input")).toHaveLength(0);
  fireEvent(window, new Event("resize"));
});

test("the display source remains self contained without feed output", () => {
  const { container } = render(<WelcomeSidebar settled views={[]} reduced={false} />);
  expect(container.querySelector("[data-welcome-session]")?.getAttribute("style")).toContain(
    "--welcome-level: 1",
  );
});

test("fold destinations follow the rendered session geometry on resize", () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    width: 450,
    height: 40,
    top: 20,
    left: 10,
    right: 460,
    bottom: 60,
    toJSON: () => ({}),
  });
  const { container } = render(<NoiseToCalm />);
  expect(tiles(container)[0]?.style.getPropertyValue("--target-w")).toBe("900px");
  container.querySelector("[data-welcome-session]")?.remove();
  fireEvent(window, new Event("resize"));
  vi.restoreAllMocks();
});
