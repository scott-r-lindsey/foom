/** The manual's stable section IDs are the only section identity source. */
export function sectionIndex(document: Document) {
  return Array.from(document.querySelectorAll<HTMLElement>("main section[id]"), (section) => {
    // NodeFilter.SHOW_TEXT's constant value also works in the build's DOM,
    // without requiring a browser global in the build process.
    const walker = document.createTreeWalker(section, 4);
    const text = [];
    while (walker.nextNode()) text.push(walker.currentNode.textContent);
    return {
      id: section.id,
      heading: section.querySelector("h2")?.textContent ?? "",
      text: text.join(" ").replace(/\s+/g, " ").trim(),
    };
  });
}

export function searchSections(index: ReturnType<typeof sectionIndex>, query: string) {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  return index.flatMap((section) => {
    const position = section.text.toLowerCase().indexOf(term);
    if (position < 0 && !section.heading.toLowerCase().includes(term)) return [];
    const start = Math.max(0, position - 45);
    const end = Math.min(section.text.length, Math.max(0, position) + term.length + 100);
    return [
      {
        ...section,
        excerpt: `${start ? "…" : ""}${section.text.slice(start, end)}${end < section.text.length ? "…" : ""}`,
      },
    ];
  });
}
