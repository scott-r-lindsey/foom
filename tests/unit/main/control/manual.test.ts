import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import {
  bundledManual,
  Manual,
  MANUAL_PAGE_SIZE,
  ManualSectionError,
} from "../../../../src/main/control/manual";
import { sectionIndex } from "../../../../src/manual/section-index";

vi.mock("node:fs", async (original) => ({ ...(await original<object>()), readFileSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const index = [{ id: "start", heading: "Start", text: "Start Foom works offline." }];

it("lists IDs, titles and summaries and reads the section without authority", () => {
  const manual = new Manual(index);
  expect(manual.read({})).toEqual({
    sections: [{ id: "start", title: "Start", summary: "Foom works offline." }],
  });
  expect(manual.read({ section: "start" })).toEqual({
    id: "start",
    title: "Start",
    text: index[0]?.text,
    page: 0,
  });
  expect(() => manual.read({ section: "../secret" })).toThrow(ManualSectionError);
  try {
    manual.read({ section: "unknown" });
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid_request", validIds: ["start"] });
  }
});

it.each([
  null,
  [],
  { path: "/secret" },
  { section: 5 },
  { section: "" },
  { section: "x".repeat(201) },
  { page: 0 },
  { section: "start", page: null },
  { section: "start", page: -1 },
  { section: "start", page: 0.5 },
  { section: "start", page: "1" },
  { section: "start", page: Number.MAX_SAFE_INTEGER + 1 },
  { section: "start", page: 1 },
])("rejects invalid arguments %j", (input) => {
  expect(() => new Manual(index).read(input)).toThrow("invalid_request");
});

it("caps pages and preserves all Unicode text across page boundaries", () => {
  const text = "a".repeat(2047) + "🚀".repeat(3000) + "\u0000".repeat(3000);
  const manual = new Manual([{ id: "long", heading: "Long", text }]);
  let page = 0;
  let combined = "";
  for (;;) {
    const result = manual.read({ section: "long", page });
    if (!("text" in result)) throw new Error("Expected section");
    expect(result.text.length).toBeLessThanOrEqual(MANUAL_PAGE_SIZE);
    const content = JSON.stringify(result);
    expect(
      Buffer.byteLength(
        JSON.stringify({ content: [{ type: "text", text: content }], structuredContent: result }),
      ),
    ).toBeLessThan(65536);
    combined += result.text;
    if (!("nextPage" in result)) break;
    page = result.nextPage;
  }
  expect(combined).toBe(text);
  expect(() => manual.read({ section: "long", page: page + 1 })).toThrow("invalid_request");
  expect(
    new Manual([{ id: "empty", heading: "Empty", text: "" }]).read({ section: "empty" }),
  ).toMatchObject({ text: "", page: 0 });
});

it("uses exactly the search extractor's index and the fixed native bundle path", () => {
  const document = new JSDOM(
    '<main><section id="one"><h2>One</h2><p>First section.</p></section><section id="two"><h2>Two</h2><p>Second section.</p></section></main>',
  );
  const sections = sectionIndex(document.window.document);
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(sections));
  const manual = bundledManual();
  expect(readFileSync).toHaveBeenCalledWith(
    expect.stringMatching(/[\\/]manual[\\/]sections\.json$/),
    "utf8",
  );
  expect(manual.read({}).sections?.map((section) => section.id)).toEqual(
    sections.map((section) => section.id),
  );
  for (const section of sections)
    expect(manual.read({ section: section.id })).toMatchObject({
      text: section.text,
      title: section.heading,
    });
  document.window.close();
});

it.each([
  {},
  Array(101).fill(index[0]),
  [{ id: 3, heading: "H", text: "T" }],
  [{ id: "x".repeat(201), heading: "H", text: "T" }],
  [{ id: "x", heading: 3, text: "T" }],
  [{ id: "x", heading: "H".repeat(201), text: "T" }],
  [{ id: "x", heading: "H", text: 3 }],
  [{ id: "x", heading: "H", text: "T".repeat(1_048_577) }],
])("refuses an invalid bundled index", (index) => {
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(index));
  expect(bundledManual).toThrow("unavailable");
});
