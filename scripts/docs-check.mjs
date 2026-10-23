import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: true });
const excluded =
  /^(?:inspiration|spikes|docs\/mockups|tests\/fixtures\/previews|node_modules|build|out|coverage|test-results|playwright-report)\//;
const instruction = /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/;

function walk(tokens, visit) {
  for (const token of tokens) {
    visit(token);
    if (token.children) walk(token.children, visit);
  }
}

function textOf(tokens) {
  return tokens
    .map((token) => {
      if (token.type === "html_inline") return "";
      if (token.children) return textOf(token.children);
      return token.content;
    })
    .join("");
}

export function parseDocument(source) {
  const tokens = markdown.parse(source, {});
  const links = [];
  const anchors = new Set();
  const used = new Set();
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== "heading_open") continue;
    const title = textOf(tokens[index + 1]?.children ?? []);
    // GitHub-style heading IDs: keep Unicode letters/numbers, spaces, - and _.
    const base = title
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, "")
      .replace(/ /g, "-");
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    anchors.add(slug);
  }
  walk(tokens, (token) => {
    if (token.type === "link_open") links.push(token.attrGet("href"));
    if (token.type === "image") links.push(token.attrGet("src"));
    if (token.type === "html_inline" || token.type === "html_block") {
      // Only real HTML tokens, never Markdown code examples or HTML comments.
      const html = token.content.replace(/<!--[\s\S]*?-->/g, "");
      for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
        for (const attr of tag[0].matchAll(
          /\b(id|name|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
        )) {
          const value = attr[2] ?? attr[3];
          if (/^(id|name)$/i.test(attr[1])) anchors.add(value);
          else links.push(value);
        }
      }
    }
  });
  return { tokens, links, anchors };
}

export function mapRows(tokens) {
  const rows = [];
  let cells;
  let cell;
  for (const token of tokens) {
    if (token.type === "tr_open") cells = [];
    if (token.type === "td_open") {
      cell = [];
      cells?.push(cell);
    }
    if (token.type === "inline" && cell) cell.push(...(token.children ?? []));
    if (token.type === "td_close") cell = undefined;
    if (token.type === "tr_close" && cells?.length === 3) {
      const patterns = cells[0]
        .filter((part) => part.type === "code_inline")
        .map((part) => part.content);
      if (patterns.length) {
        rows.push({
          patterns,
          links: cells[2]
            .filter((part) => part.type === "link_open")
            .map((part) => part.attrGet("href")),
        });
      }
    }
  }
  return rows;
}

function matches(file, pattern) {
  return pattern.endsWith("/") ? file.startsWith(pattern) : path.posix.matchesGlob(file, pattern);
}

export function readingFor(file, rows) {
  return [
    ...new Set(
      rows
        .filter((row) => row.patterns.some((pattern) => matches(file, pattern)))
        .flatMap((row) => row.links),
    ),
  ];
}

/** Files is the Git inventory, injectable so fixture tests never need real CLIs. */
export function checkDocs(root, files) {
  const errors = [];
  const documents = new Map();
  function document(file) {
    if (!documents.has(file))
      documents.set(file, parseDocument(readFileSync(path.join(root, file), "utf8")));
    return documents.get(file);
  }
  const sources = files.filter((file) => file.startsWith("src/") && !instruction.test(file));
  const rows = mapRows(document("docs/map.md").tokens);
  for (const row of rows) {
    if (!row.links.length) errors.push("docs/map.md: owner row has no required reading links");
    for (const pattern of row.patterns) {
      if (!pattern.startsWith("src/") || pattern.includes("..") || pattern.includes("\\")) {
        errors.push(`docs/map.md: invalid full-path source pattern ${pattern}`);
      } else if (!sources.some((file) => matches(file, pattern))) {
        errors.push(`docs/map.md: source pattern matches no tracked files: ${pattern}`);
      }
    }
  }
  for (const file of sources) {
    if (!readingFor(file, rows).length) errors.push(`docs/map.md: unmapped source: ${file}`);
  }
  for (const file of files.filter((file) => file.endsWith(".md") && !excluded.test(file))) {
    for (const href of document(file).links) {
      // No network checks. Protocol URLs, including hostile examples, are inert.
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
      const hash = href.indexOf("#");
      const fragment = hash < 0 ? undefined : href.slice(hash + 1);
      const pathname = (hash < 0 ? href : href.slice(0, hash)).split("?", 1)[0];
      let target;
      let anchor;
      try {
        target = path.posix.normalize(
          pathname.startsWith("/")
            ? decodeURIComponent(pathname.slice(1))
            : path.posix.join(path.posix.dirname(file), decodeURIComponent(pathname)),
        );
        anchor = fragment === undefined ? undefined : decodeURIComponent(fragment);
      } catch {
        errors.push(`${file}: invalid link encoding: ${href}`);
        continue;
      }
      if (!pathname) target = file;
      if (target === ".." || target.startsWith("../") || !existsSync(path.join(root, target))) {
        errors.push(`${file}: missing local link target: ${href}`);
      } else if (
        anchor &&
        target.endsWith(".md") &&
        statSync(path.join(root, target)).isFile() &&
        !excluded.test(target) &&
        !document(target).anchors.has(anchor)
      ) {
        errors.push(`${file}: missing anchor: ${href}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const errors = checkDocs(root, files);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.info("Documentation links, anchors and source map coverage passed.");
}
