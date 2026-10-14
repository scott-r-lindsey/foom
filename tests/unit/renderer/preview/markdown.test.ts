// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { renderDocument, renderMarkdown } from "../../../../src/renderer/preview/markdown";

test("hostile Markdown has no executable elements, handlers, or unsafe links", () => {
  const source = readFileSync("tests/fixtures/previews/hostile.md", "utf8");
  document.body.innerHTML = renderMarkdown(source);
  expect(document.querySelector("script, iframe, object, embed")).toBeNull();
  for (const element of document.querySelectorAll("*")) {
    expect(element.getAttributeNames().some((name) => name.startsWith("on"))).toBe(false);
  }
  expect([...document.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
    "http://127.0.0.1",
    "../../../../etc/hostname",
    "../demo/other.md",
    "https://example.com",
  ]);
  expect(document.querySelector('img[src^="data:"]')).toBeNull();
  expect(document.body.textContent).toContain("<script>window.__pwned");
  expect(document.body.textContent).toContain("raw anchor");
});

test("renders structure, nested tasks, safe links and highlighted common languages", () => {
  document.body.innerHTML = renderMarkdown(`# Heading

| a | b |
| - | - |
| 1 | 2 |

- [ ] pending
- [x] done
  - [X] nested
- normal **text**

[local](sibling.md) [secure](https://example.com) [mail](mailto:a@example.com) [network](//example.com)

https://example.org

\`\`\`javascript
const value = "<script>";
\`\`\`

\`\`\`unknown
<script>
\`\`\`

\`\`\`mermaid
graph TD; A-->B
\`\`\`
`);
  expect(document.querySelector("h1")?.textContent).toBe("Heading");
  expect(document.querySelectorAll("td")).toHaveLength(2);
  const tasks = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(tasks.map((task) => [task.checked, task.disabled])).toEqual([
    [false, true],
    [true, true],
    [true, true],
  ]);
  expect(document.querySelectorAll("li.task")).toHaveLength(3);
  expect(document.querySelector('a[href="sibling.md"]')?.className).toBe("");
  expect(document.querySelectorAll("a.external")).toHaveLength(4);
  expect(document.querySelector(".hljs-keyword")?.textContent).toBe("const");
  expect([...document.querySelectorAll("pre code")].map((code) => code.textContent)).toEqual([
    'const value = "<script>";\n',
    "<script>\n",
    "graph TD; A-->B\n",
  ]);
  expect(document.querySelectorAll("pre code")[2]?.children).toHaveLength(0);
  expect(renderMarkdown("```\n<&>\n``` ")).toContain("&lt;&amp;&gt;");
});

test("runtime renders the inert source synchronously and ignores missing or invalid data", async () => {
  document.body.innerHTML =
    '<main id="content"></main><script id="source" type="application/json">"# Ready"</script>';
  vi.resetModules();
  await import("../../../../src/renderer/preview/runtime");
  expect(document.querySelector("h1")?.textContent).toBe("Ready");
  document.body.innerHTML = '<main id="content"></main>';
  renderDocument(document);
  expect(document.getElementById("content")?.innerHTML).toBe("");
  document.body.innerHTML = '<script id="source" type="application/json">"text"</script>';
  renderDocument(document);
});
