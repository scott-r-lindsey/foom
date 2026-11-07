import type { Terminal } from "@xterm/xterm";
import type { DesktopApi } from "../../shared/desktop";
import { linksOnRow, type TerminalLink } from "./link-lookup";

/** Foom owns gestures; xterm's built-in OSC handler is deliberately inert. */
export function terminalLinks(
  container: HTMLElement,
  terminal: Pick<
    Terminal,
    | "buffer"
    | "cols"
    | "rows"
    | "onRender"
    | "onScroll"
    | "onResize"
    | "onWriteParsed"
    | "getSelection"
  >,
  target: () => string | undefined,
  desktop: Pick<DesktopApi, "openTerminalLink" | "copyTerminalLink"> = window.desktop,
) {
  let dirty = true;
  let screen: HTMLElement | null = null;
  let overlay: HTMLElement | undefined;
  let hover: TerminalLink | undefined;
  let pressed:
    | { link: TerminalLink; dirty: boolean; x: number; y: number; id: string; selection: string }
    | undefined;
  let rendered: TerminalLink[] = [];
  const open = (link: TerminalLink, uncertain = false) => {
    const id = target();
    const row = link.rows[0];
    const current =
      row &&
      linksOnRow(terminal, row.y).find(
        (candidate) =>
          candidate.url === link.url &&
          candidate.rows.some(
            (range) => range.y === row.y && range.start <= row.start && range.end > row.start,
          ),
      );
    // Keyboard overlays/menu closures may predate a theme or output change.
    if (id && current) {
      const top = terminal.buffer.active.viewportY;
      const visible = current.rows.every(
        (range) =>
          range.y >= top &&
          range.y < top + terminal.rows &&
          range.start >= 0 &&
          range.end <= terminal.cols,
      );
      void desktop
        .openTerminalLink(
          id,
          current.url,
          visible && !dirty && !uncertain && JSON.stringify(link) === JSON.stringify(current)
            ? current.text
            : undefined,
        )
        .catch(() => {});
    }
  };
  const lookup = (event: MouseEvent): TerminalLink | undefined => {
    const element = container.querySelector<HTMLElement>(".xterm-screen");
    if (!element) return undefined;
    const rect = element.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) * terminal.cols) / rect.width);
    const y = Math.floor(((event.clientY - rect.top) * terminal.rows) / rect.height);
    if (x < 0 || x >= terminal.cols || y < 0 || y >= terminal.rows) return undefined;
    const row = terminal.buffer.active.viewportY + y;
    return linksOnRow(terminal, row).find((link) =>
      link.rows.some((range) => range.y === row && x >= range.start && x < range.end),
    );
  };
  const highlight = (link?: TerminalLink) => {
    hover = link;
    if (!screen) return;
    screen.title = link?.url ?? "";
    screen.style.cursor = link ? "pointer" : "";
    for (const [index, element] of Array.from(overlay?.children ?? []).entries()) {
      const current = rendered[index];
      element.classList.toggle(
        "hovered",
        !!link && current?.url === link.url && current.rows[0]?.y === link.rows[0]?.y,
      );
    }
  };
  const render = () => {
    screen = container.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || !dirty) return;
    dirty = false;
    // Keep focused links and their keyboard focus across ordinary cursor repaints.
    const next: TerminalLink[] = [];
    const viewport = terminal.buffer.active.viewportY;
    const keys = new Set<string>();
    for (let y = viewport; y < viewport + terminal.rows; y++) {
      for (const link of linksOnRow(terminal, y)) {
        const key = JSON.stringify([link.url, link.rows]);
        if (keys.has(key)) continue;
        keys.add(key);
        next.push(link);
      }
    }
    if (
      overlay &&
      JSON.stringify(next) === JSON.stringify(rendered) &&
      overlay.dataset["viewport"] === String(viewport) &&
      overlay.dataset["grid"] === `${String(terminal.cols)}:${String(terminal.rows)}`
    )
      return;
    overlay?.remove();
    overlay = document.createElement("div");
    overlay.className = "terminal-links";
    overlay.dataset["viewport"] = String(viewport);
    overlay.dataset["grid"] = `${String(terminal.cols)}:${String(terminal.rows)}`;
    rendered = next;
    for (const link of rendered) {
      const element = document.createElement("span");
      element.className = "terminal-link";
      element.tabIndex = 0;
      element.setAttribute("role", "link");
      element.setAttribute("aria-label", link.url);
      element.title = link.url;
      for (const row of link.rows) {
        if (row.y < viewport || row.y >= viewport + terminal.rows) continue;
        const segment = document.createElement("span");
        segment.style.left = `${String((row.start / terminal.cols) * 100)}%`;
        segment.style.top = `${String(((row.y - viewport) / terminal.rows) * 100)}%`;
        segment.style.width = `${String(((row.end - row.start) / terminal.cols) * 100)}%`;
        segment.style.height = `${String(100 / terminal.rows)}%`;
        element.appendChild(segment);
      }
      element.addEventListener("keydown", (event) => {
        if (!event.isTrusted) return;
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
          const row = link.rows.find(
            (range) => range.y >= viewport && range.y < viewport + terminal.rows,
          );
          const bounds = screen?.getBoundingClientRect();
          if (!row || !bounds) return;
          // An actual keyboard menu gesture uses the same independent pointer lookup.
          container.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              button: 2,
              shiftKey: true,
              clientX: bounds.left + ((row.start + 0.5) * bounds.width) / terminal.cols,
              clientY: bounds.top + ((row.y - viewport + 0.5) * bounds.height) / terminal.rows,
            }),
          );
        } else if (event.key === "Enter") open(link);
        else return;
        event.preventDefault();
        event.stopPropagation();
      });
      element.addEventListener("focus", () => {
        highlight(link);
      });
      element.addEventListener("blur", () => {
        highlight();
      });
      overlay.appendChild(element);
    }
    // Put links before xterm's textarea in Tab order; Tab within the textarea belongs to the program.
    screen.prepend(overlay);
    highlight(hover);
  };
  const move = (event: MouseEvent) => {
    highlight(lookup(event));
  };
  const leave = () => {
    highlight();
  };
  const down = (event: MouseEvent) => {
    pressed = undefined;
    if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey)
      return;
    const link = lookup(event);
    const id = target();
    if (link && id)
      pressed = {
        link,
        dirty,
        x: event.clientX,
        y: event.clientY,
        id,
        selection: terminal.getSelection(),
      };
  };
  const up = (event: MouseEvent) => {
    const previous = pressed;
    pressed = undefined;
    // Check the button here too: stale primary state must not activate on right/middle release.
    if (
      !event.isTrusted ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !previous ||
      previous.id !== target()
    )
      return;
    if (
      Math.abs(previous.x - event.clientX) > 3 ||
      Math.abs(previous.y - event.clientY) > 3 ||
      (terminal.getSelection() && terminal.getSelection() !== previous.selection)
    )
      return;
    const link = lookup(event);
    if (link?.url === previous.link.url)
      open(link, previous.dirty || JSON.stringify(link) !== JSON.stringify(previous.link));
  };
  const offRender = terminal.onRender(render);
  // Scroll fires for each parsed line, inside the parser. Only invalidate here;
  // xterm's frame-coalesced onRender is the sole place that sweeps the viewport.
  const refresh = () => {
    dirty = true;
  };
  const offParsed = terminal.onWriteParsed(() => {
    dirty = true;
  });
  const offScroll = terminal.onScroll(refresh);
  const offResize = terminal.onResize(refresh);
  container.addEventListener("mousemove", move);
  container.addEventListener("mouseleave", leave);
  container.addEventListener("mousedown", down, true);
  container.addEventListener("mouseup", up, true);
  return {
    at: lookup,
    menu: (event: MouseEvent) => {
      const link = lookup(event);
      const id = target();
      const uncertain = dirty;
      if (!link || !id) return undefined;
      return {
        url: link.url,
        copy: () => {
          return target() === id ? desktop.copyTerminalLink(id, link.url) : Promise.resolve();
        },
        open: () => {
          if (target() === id) open(link, uncertain);
        },
      };
    },
    dispose: () => {
      offRender.dispose();
      offParsed.dispose();
      offScroll.dispose();
      offResize.dispose();
      container.removeEventListener("mousemove", move);
      container.removeEventListener("mouseleave", leave);
      container.removeEventListener("mousedown", down, true);
      container.removeEventListener("mouseup", up, true);
      overlay?.remove();
      highlight();
    },
  };
}
