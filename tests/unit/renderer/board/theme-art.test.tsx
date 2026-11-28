// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ActionError } from "../../../../src/renderer/board/error-presentation";
import {
  ThemeArt,
  ThemeArtContext,
  themeArtChoice,
} from "../../../../src/renderer/board/theme-art";
import { artFixture } from "../../../fixtures/theme-art";

afterEach(cleanup);

test("two regions choose independently and retain their pieces when resized or updated", () => {
  const firstId = "a".repeat(64);
  const secondId = "b".repeat(64);
  const random = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.99);
  const regions = (width: number) => (
    <ThemeArtContext value={{ ...artFixture, slots: { ...artFixture.slots } }}>
      <ThemeArt slot="empty" style={{ width }} />
      <ThemeArt slot="empty" className="seam" hidden direction="horizontal" />
      <ThemeArt slot="tile-header" />
      <ThemeArt slot="sidebar" />
    </ThemeArtContext>
  );
  const view = render(regions(50));
  const elements = view.container.querySelectorAll<HTMLElement>("[data-theme-art]");
  expect(elements).toHaveLength(4);
  expect(elements[0]?.style.backgroundImage).toContain(firstId);
  expect(elements[0]?.style.backgroundPosition).toBe("left top");
  expect(elements[0]?.style.backgroundRepeat).toBe("repeat");
  expect(elements[1]?.style.backgroundImage).toContain(secondId);
  expect(elements[1]?.style.backgroundSize).toBe("cover");
  expect(elements[1]?.style.backgroundRepeat).toBe("no-repeat");
  expect(elements[1]?.classList.contains("seam")).toBe(true);
  expect(elements[1]?.hidden).toBe(true);
  random.mockClear();
  view.rerender(regions(250));
  expect(elements[0]?.style.width).toBe("250px");
  expect(elements[0]?.style.backgroundImage).toContain(firstId);
  expect(elements[1]?.style.backgroundImage).toContain(secondId);
  expect(random).not.toHaveBeenCalled();

  const pieces = artFixture.slots.empty ?? [];
  expect(themeArtChoice(pieces.slice(1), firstId, () => 0)?.id).toBe(secondId);
  expect(themeArtChoice([], firstId, () => 0)).toBeUndefined();
});

test("a board dialog has no artwork when empty and header artwork are active", () => {
  const view = render(
    <ThemeArtContext value={artFixture}>
      <ThemeArt slot="empty" />
      <ThemeArt slot="tile-header" />
      <ActionError close={() => {}} message="A fixture error" />
    </ThemeArtContext>,
  );
  expect(view.container.querySelectorAll("[data-theme-art]")).toHaveLength(2);
  const dialog = view.getByRole("dialog", { name: "Action failed" });
  expect(dialog.querySelector("[data-theme-art]")).toBeNull();
  expect(dialog.outerHTML).not.toContain("foom-theme:");
});
