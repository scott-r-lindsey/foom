// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { OrchestrationMark } from "../../../../src/renderer/board/orchestration-mark";

afterEach(cleanup);

test("reviewer lens matches the approved receiving robot and carries its own accessible name", () => {
  const view = render(<OrchestrationMark kind="review" related title="Child of parent" />);
  const mark = view.getByRole("img", { name: "Reviewer" });
  expect(mark.getAttribute("viewBox")).toBe("0 0 18 16");
  expect(mark.getAttribute("data-related")).toBe("true");
  expect(mark.querySelector("rect")?.getAttribute("x")).toBe("3");
  expect(mark.querySelector(".robot-lens")?.getAttribute("r")).toBe("2.6");
  expect(mark.querySelector(".robot-handle")?.getAttribute("d")).toBe("M13.1 12.3l2.4 2.4");
  expect(mark.querySelector(".robot-wave-inner")?.getAttribute("d")).toBe(
    "M5.9 2.2a3 3 0 0 1 4.2 0",
  );
  expect(mark.querySelector(".robot-wave-outer")?.getAttribute("d")).toBe(
    "M4.2 0.6a5.4 5.4 0 0 1 7.6 0",
  );
  view.rerender(<OrchestrationMark kind="review" related={false} />);
  expect(mark.getAttribute("data-related")).toBe("false");
  expect(mark.querySelector("title")).toBeNull();
});
