// Runs inside the isolated preview origin, never in the board. Bundled by
// build.cjs into .build/markdown.js and served at /__foom__/markdown.js.
import hljs from "highlight.js/lib/common";
import MarkdownIt from "markdown-it";

const escape = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const md = new MarkdownIt({
  html: false, // raw HTML is shown as text, never parsed
  linkify: true,
  highlight(code, language) {
    const lang = language && hljs.getLanguage(language) ? language : null;
    const body = lang ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : escape(code);
    return `<pre class="hljs"><code${lang ? ` data-lang="${escape(lang)}"` : ""}>${body}</code></pre>`;
  },
});

// GitHub task lists: "- [ ] x" and "- [x] x" become disabled checkboxes.
md.core.ruler.after("inline", "task-lists", (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
    const first = inline.children[0];
    const match = first?.type === "text" && /^\[([ xX])\] /.exec(first.content);
    if (!match) continue;
    first.content = first.content.slice(4);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" disabled${match[1] === " " ? "" : " checked"}> `;
    inline.children.unshift(box);
    tokens[i - 2].attrJoin("class", "task");
  }
});

// External links are marked so the stylesheet can show them; main decides
// whether to open them. Relative links resolve inside this origin unchanged.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href") ?? "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) tokens[idx].attrJoin("class", "external");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const source = JSON.parse(document.getElementById("source").textContent);
document.getElementById("content").innerHTML = md.render(source);
