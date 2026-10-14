import hljs from "highlight.js/lib/common";
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(code, language): string {
    const body =
      language && hljs.getLanguage(language)
        ? hljs.highlight(code, { language, ignoreIllegals: true }).value
        : md.utils.escapeHtml(code);
    return `<pre class="hljs"><code>${body}</code></pre>`;
  },
});
// No file:, data: (including images), or custom protocol capabilities in Markdown.
md.validateLink = (url) =>
  !/^(?:[a-z][a-z0-9+.-]*:)/i.test(url) || /^(?:https?:|mailto:)/i.test(url);

md.core.ruler.after("inline", "task-lists", (state) => {
  for (let i = 2; i < state.tokens.length; i++) {
    const inline = state.tokens[i];
    const item = state.tokens[i - 2];
    if (
      inline?.type !== "inline" ||
      state.tokens[i - 1]?.type !== "paragraph_open" ||
      item?.type !== "list_item_open"
    )
      continue;
    const first = inline.children?.[0];
    const match = first?.type === "text" && /^\[([ xX])\] /.exec(first.content);
    if (!match || !inline.children) continue;
    first.content = first.content.slice(4);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" disabled aria-label="Task"${match[1] === " " ? "" : " checked"}> `;
    inline.children.unshift(box);
    item.attrJoin("class", "task");
  }
});
md.renderer.rules["link_open"] = (tokens, index, options, _env, renderer) => {
  const token = tokens[index];
  const href = token?.attrGet("href") ?? "";
  if (typeof href === "string" && /^(?:https?:|mailto:|\/\/)/i.test(href)) {
    token?.attrJoin("class", "external");
    token?.attrSet("rel", "noreferrer noopener");
  }
  return renderer.renderToken(tokens, index, options);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}

/** Runs synchronously after the inert JSON source and content element exist. */
export function renderDocument(document: Document): void {
  const source: unknown = JSON.parse(document.getElementById("source")?.textContent ?? "null");
  const content = document.getElementById("content");
  if (typeof source === "string" && content) content.innerHTML = renderMarkdown(source);
}
