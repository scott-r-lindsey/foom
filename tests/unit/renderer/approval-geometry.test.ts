// @vitest-environment jsdom
import { expect, test } from "vitest";
import { ApprovalGeometry } from "../../../src/renderer/approval-geometry";

test("each decision's monotonic guard restarts on movement and ignores withdrawn controls", () => {
  let now = 0;
  const root = document.createElement("main");
  const accept = document.createElement("button");
  const decline = document.createElement("button");
  const bulk = document.createElement("button");
  accept.dataset["approvalDecision"] = "row";
  decline.dataset["approvalDecision"] = "row";
  bulk.dataset["approvalDecision"] = "bulk";
  root.append(accept, decline, bulk);
  let rect = { x: 10, y: 20, width: 80, height: 30 };
  accept.getBoundingClientRect = () => DOMRect.fromRect(rect);
  const geometry = new ApprovalGeometry(() => now);
  expect(geometry.read(root)).toEqual({ blocked: ["row", "bulk"], delay: 900 });
  now = 899;
  expect(geometry.ready(root, "row")).toBe(false);
  now = 900;
  expect(geometry.ready(root, "row")).toBe(true);
  expect(geometry.ready(root, "absent")).toBe(false);
  for (const field of ["x", "y", "width", "height"] as const) {
    rect = { ...rect, [field]: rect[field] + 1 };
    expect(geometry.ready(root, "row")).toBe(false);
    expect(geometry.ready(root, "bulk")).toBe(true);
    now += 899;
    expect(geometry.read(root)).toEqual({ blocked: ["row"], delay: 1 });
    now++;
    expect(geometry.ready(root, "row")).toBe(true);
  }
  accept.remove();
  decline.remove();
  expect(geometry.ready(root, "row")).toBe(false);
  bulk.removeAttribute("data-approval-decision");
  expect(geometry.read(root)).toEqual({ blocked: [], delay: Infinity });
});

test("a main native-geometry revision re-arms unchanged CSS rectangles for every decision", () => {
  let now = 0;
  const root = document.createElement("main");
  for (const id of ["row", "bulk"]) {
    const button = document.createElement("button");
    button.setAttribute("data-approval-decision", id);
    root.append(button);
  }
  const geometry = new ApprovalGeometry(() => now);
  geometry.read(root, 1);
  now = 900;
  expect(geometry.ready(root, "row", 1)).toBe(true);
  expect(geometry.ready(root, "bulk", 1)).toBe(true);
  expect(geometry.read(root, 2)).toEqual({ blocked: ["row", "bulk"], delay: 900 });
  now = 1799;
  expect(geometry.ready(root, "row", 2)).toBe(false);
  expect(geometry.ready(root, "bulk", 2)).toBe(false);
  now = 1800;
  expect(geometry.ready(root, "row", 2)).toBe(true);
  expect(geometry.ready(root, "bulk", 2)).toBe(true);
});
