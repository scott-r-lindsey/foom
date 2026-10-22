// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchSections, sectionIndex } from "../../../src/manual/section-index";

const markup = `<input id="manual-query"><ul id="manual-results" hidden></ul><main>
<section id="one"><h2>Alpha</h2><p>Offline manual</p></section>
<section id="two"><h2>Beta</h2><p>${"x".repeat(100)} searchable ${"y".repeat(200)}</p></section>
<section id="three"></section></main>`;
const key = (value: string, options: KeyboardEventInit = {}) =>
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options }),
  );
const input = () => {
  const field = document.querySelector<HTMLInputElement>("input");
  if (!field) throw new Error("Missing search field");
  return field;
};
const type = (value: string) => {
  input().value = value;
  input().dispatchEvent(new Event("input"));
};
const items = () => Array.from(document.querySelectorAll('[role="option"]'));

const spyListeners = () => vi.spyOn(document, "addEventListener");
let listeners: ReturnType<typeof spyListeners>;
beforeEach(() => {
  vi.resetModules();
  listeners = spyListeners();
  vi.useFakeTimers();
  document.body.innerHTML = markup;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  for (const [name, listener] of listeners.mock.calls) document.removeEventListener(name, listener);
  vi.useRealTimers();
});

describe("manual section index", () => {
  it("keeps stable IDs, normalizes text and returns bounded literal excerpts", () => {
    const index = sectionIndex(document);
    expect(index.map((section) => section.id)).toEqual(["one", "two", "three"]);
    expect(searchSections(index, "  OFFLINE ")[0]?.id).toBe("one");
    expect(searchSections(index, "searchable")[0]?.excerpt).toMatch(/^….*searchable.*…$/);
    expect(searchSections(index, "")).toEqual([]);
    expect(searchSections(index, "[.*")).toEqual([]);
    expect(searchSections([{ id: "heading", heading: "only", text: "" }], "only")[0]?.id).toBe(
      "heading",
    );
    document.querySelector("#three")?.replaceChildren();
    expect(index[2]).toEqual({ id: "three", heading: "", text: "" });
  });
});

it("supports keyboard selection, wrapping, jumping, clearing and timed highlights", async () => {
  await import("../../../src/manual/search");
  key("/");
  expect(document.activeElement).toBe(input());
  type("a");
  expect(items()).toHaveLength(2);
  expect(input().getAttribute("aria-activedescendant")).toBe("manual-result-0");
  key("ArrowUp");
  expect(items()[1]?.getAttribute("aria-selected")).toBe("true");
  key("ArrowDown");
  expect(items()[0]?.getAttribute("aria-selected")).toBe("true");
  key("Enter");
  expect(document.activeElement?.id).toBe("one");
  expect(document.querySelector("#one")?.classList.contains("search-hit")).toBe(true);
  expect(items()).toHaveLength(0);
  key("f", { ctrlKey: true });
  type("searchable");
  items()[0]?.dispatchEvent(new MouseEvent("click"));
  expect(document.activeElement?.id).toBe("two");
  expect(document.querySelector("#one")?.classList.contains("search-hit")).toBe(false);
  vi.advanceTimersByTime(1600);
  expect(document.querySelector(".search-hit")).toBeNull();
  key("f", { metaKey: true });
  type("nonexistent");
  expect(items()).toHaveLength(0);
  key("ArrowDown");
  key("Enter");
  key("Escape");
  expect(input().value).toBe("");
  expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  expect(input().getAttribute("aria-expanded")).toBe("false");
  key("/");
  key("z");
  key("f", { ctrlKey: true, isComposing: true });
  input().dispatchEvent(new Event("search"));
});

it("uses text nodes for excerpts and tolerates a removed target section", async () => {
  document.querySelector("#one p")?.append(" <img src=x>");
  await import("../../../src/manual/search");
  input().focus();
  type("<img");
  expect(items()[0]?.textContent).toContain("<img src=x>");
  expect(document.querySelector("img")).toBeNull();
  document.querySelector("#one")?.remove();
  key("Enter");
  expect(document.activeElement).toBe(input());
});

it("leaves pages without search controls alone", async () => {
  document.body.replaceChildren();
  await import("../../../src/manual/search");
});
