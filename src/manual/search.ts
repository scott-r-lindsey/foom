import { searchSections, sectionIndex } from "./section-index";

const input = document.querySelector<HTMLInputElement>("#manual-query");
const list = document.querySelector<HTMLUListElement>("#manual-results");
if (input && list) {
  const index = sectionIndex(document);
  let results: ReturnType<typeof searchSections> = [];
  let selected = 0;
  let highlighted: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const select = (position: number) => {
    selected = position;
    Array.from(list.children).forEach((item, i) => {
      item.setAttribute("aria-selected", String(i === selected));
    });
    const active = list.children[selected];
    if (active) {
      input.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const render = () => {
    results = searchSections(index, input.value);
    list.replaceChildren();
    for (const [i, result] of results.entries()) {
      const item = document.createElement("li");
      item.id = `manual-result-${String(i)}`;
      item.setAttribute("role", "option");
      const heading = document.createElement("strong");
      heading.textContent = result.heading;
      const excerpt = document.createElement("span");
      excerpt.textContent = result.excerpt;
      item.append(heading, excerpt);
      item.addEventListener("click", () => {
        jump(i);
      });
      list.append(item);
    }
    list.hidden = results.length === 0;
    input.setAttribute("aria-expanded", String(!list.hidden));
    select(0);
  };
  const jump = (position: number) => {
    const result = results[position];
    if (!result) return;
    const section = document.getElementById(result.id);
    if (!section) return;
    highlighted?.classList.remove("search-hit");
    clearTimeout(timer);
    highlighted = section;
    section.classList.add("search-hit");
    input.value = "";
    render();
    section.tabIndex = -1;
    section.focus({ preventScroll: true });
    section.scrollIntoView({ block: "start" });
    timer = setTimeout(() => {
      section.classList.remove("search-hit");
    }, 1600);
  };
  input.addEventListener("input", render);
  input.addEventListener("search", render);
  document.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const editing =
      event.target instanceof HTMLElement &&
      (event.target.matches("input, textarea") || event.target.isContentEditable);
    if (
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") ||
      (event.key === "/" && !editing && !event.ctrlKey && !event.metaKey && !event.altKey)
    ) {
      event.preventDefault();
      input.focus();
      input.select();
    } else if (event.key === "Escape") {
      event.preventDefault();
      input.value = "";
      render();
    } else if (event.target === input) {
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
        event.preventDefault();
        select((selected + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        jump(selected);
      }
    }
  });
}
