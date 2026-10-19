// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { RecentDaysInput } from "../../../../src/renderer/preflight/recent-days-input";

afterEach(cleanup);
function Harness() {
  const [value, setValue] = useState(30);
  return <RecentDaysInput value={value} onChange={setValue} />;
}

test("typing permits an empty draft and commits valid integers or clamps on blur", () => {
  const changed = vi.fn();
  const view = render(<RecentDaysInput value={30} onChange={changed} />);
  const input = screen.getByRole("spinbutton");
  for (const value of ["", "0", "366", "2.5"]) fireEvent.change(input, { target: { value } });
  expect(changed).not.toHaveBeenCalled();
  fireEvent.blur(input);
  expect(changed).toHaveBeenLastCalledWith(3);
  fireEvent.change(input, { target: { value: "20" } });
  expect(changed).toHaveBeenLastCalledWith(20);
  view.unmount();
  render(<Harness />);
  const field = screen.getByRole("spinbutton");
  for (const [typed, expected] of [
    ["0", "1"],
    ["999", "365"],
    ["", "365"],
  ]) {
    fireEvent.change(field, { target: { value: typed } });
    fireEvent.blur(field);
    expect(field).toHaveProperty("value", expected);
  }
});

test("wheel consumes scrolling, accumulates trackpad deltas and clamps each notch", () => {
  render(<Harness />);
  const input = screen.getByRole("spinbutton");
  expect(fireEvent.wheel(input, { deltaY: -20 })).toBe(false);
  expect(input).toHaveProperty("value", "30");
  fireEvent.wheel(input, { deltaY: -30 });
  expect(input).toHaveProperty("value", "31");
  fireEvent.wheel(input, { deltaY: 100 });
  expect(input).toHaveProperty("value", "30");
  fireEvent.change(input, { target: { value: "365" } });
  fireEvent.blur(input);
  fireEvent.wheel(input, { deltaY: -1, deltaMode: 1 });
  expect(input).toHaveProperty("value", "365");
  fireEvent.change(input, { target: { value: "1" } });
  fireEvent.blur(input);
  fireEvent.wheel(input, { deltaY: 1, deltaMode: 1 });
  expect(input).toHaveProperty("value", "1");
});
