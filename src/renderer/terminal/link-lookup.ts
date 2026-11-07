import type { IBuffer, IBufferCell, Terminal } from "@xterm/xterm";
import {
  terminalLink,
  TERMINAL_LINK_LIMIT,
  terminalOscId,
  terminalOscTarget,
} from "../../shared/terminal-link";

export interface LinkRow {
  y: number;
  start: number;
  end: number;
}
export interface TerminalLink {
  url: string;
  /** Undefined means the complete visible label could not be established. */
  text: string | undefined;
  rows: LinkRow[];
}

type LinkTerminal = Pick<Terminal, "buffer" | "cols"> & Partial<Pick<Terminal, "options">>;

// Explicit cell colors, faint/inverse attributes and unresolvable theme colors
// take the safe path. We do not try to reproduce xterm's renderer/color pipeline.
function displayed(cell: IBufferCell | undefined, defaultsVisible: boolean): boolean {
  return (
    !!cell &&
    defaultsVisible &&
    !cell.isInvisible() &&
    !cell.isDim() &&
    !cell.isInverse() &&
    cell.isFgDefault() &&
    cell.isBgDefault()
  );
}

/** Coordinates are zero-based buffer cells, independently of xterm's hover state. */
export function linksOnRow(terminal: LinkTerminal, y: number): TerminalLink[] {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(y);
  if (!line) return [];
  const theme = terminal.options?.theme;
  const foreground = theme?.foreground ?? "#ffffff";
  const background = theme?.background ?? "#000000";
  const defaultsVisible =
    /^#[a-f\d]{6}$/iu.test(foreground) &&
    /^#[a-f\d]{6}$/iu.test(background) &&
    foreground.toLowerCase() !== background.toLowerCase();
  const result: TerminalLink[] = [];
  const seen = new Set<number>();
  for (let x = 0; x < terminal.cols; x++) {
    const id = terminalOscId(line.getCell(x));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const url = terminalOscTarget(terminal, id);
    if (typeof url !== "string" || !terminalLink(url)) continue;
    const rows: LinkRow[] = [];
    let text = "";
    let complete = true;
    // A linked run may have application-authored newlines as well as soft wraps.
    // Retain newlines in its label: they must never become an exact URL match.
    const maxRows = Math.ceil(TERMINAL_LINK_LIMIT / terminal.cols) + 2;
    let first = y;
    while (first > 0 && y - first < maxRows && hasId(buffer, first - 1, id, terminal.cols)) first--;
    if (first > 0 && hasId(buffer, first - 1, id, terminal.cols)) complete = false;
    for (let row = first; row < buffer.length && row - first < maxRows; row++) {
      const current = buffer.getLine(row);
      if (!current || !hasId(buffer, row, id, terminal.cols)) break;
      if (rows.length && !current.isWrapped) text += "\n";
      let start = -1;
      for (let col = 0; col <= terminal.cols; col++) {
        const cell = current.getCell(col);
        if (col < terminal.cols && terminalOscId(cell) === id) {
          if (start < 0) start = col;
          // Concealed text must never qualify as a fully displayed destination.
          if (!displayed(cell, defaultsVisible)) complete = false;
          text += cell?.getChars() ?? "";
        } else if (start >= 0) {
          const previous = rows.at(-1);
          if (
            previous &&
            (previous.y !== row - 1 ||
              !current.isWrapped ||
              previous.end !== terminal.cols ||
              start !== 0)
          )
            complete = false;
          rows.push({ y: row, start, end: col });
          start = -1;
        }
      }
      if (row - first === maxRows - 1 && hasId(buffer, row + 1, id, terminal.cols))
        complete = false;
    }
    result.push({
      url,
      text: complete && text.length <= TERMINAL_LINK_LIMIT ? text : undefined,
      rows,
    });
  }

  // Only xterm's soft-wrap metadata joins plain text. Never infer hard-newline continuations.
  const maxRows = Math.ceil(TERMINAL_LINK_LIMIT / terminal.cols) + 2;
  let first = y;
  while (first > 0 && buffer.getLine(first)?.isWrapped && y - first < maxRows) first--;
  if (buffer.getLine(first)?.isWrapped) return result;
  let text = "";
  const positions: {
    x: number;
    y: number;
    width: number;
    hidden: boolean;
    osc: number | undefined;
  }[] = [];
  let end = first;
  do {
    const current = buffer.getLine(end);
    if (!current) break;
    for (let x = 0; x < terminal.cols; x++) {
      const cell = current.getCell(x);
      if (cell?.getWidth() === 0) continue;
      const chars = cell?.getChars() || " ";
      text += chars;
      for (let i = 0; i < chars.length; i++)
        positions.push({
          x,
          y: end,
          width: cell?.getWidth() || 1,
          hidden: !displayed(cell, defaultsVisible),
          osc: terminalOscId(cell),
        });
    }
    end++;
  } while (buffer.getLine(end)?.isWrapped && end - first < maxRows);
  if (buffer.getLine(end)?.isWrapped) return result;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
    // Sentence punctuation is not part of an unquoted URL; balanced URL parentheses survive.
    let url = match[0].replace(/[.,;:!?]+$/u, "");
    while (url.endsWith(")") && url.split(")").length > url.split("(").length)
      url = url.slice(0, -1);
    if (!terminalLink(url)) continue;
    const cells = positions.slice(match.index, match.index + url.length);
    if (cells.some((cell) => cell.osc !== 0)) continue;
    const rows: LinkRow[] = [];
    for (const cell of cells) {
      const last = rows.at(-1);
      if (last?.y === cell.y) last.end = cell.x + cell.width;
      else rows.push({ y: cell.y, start: cell.x, end: cell.x + cell.width });
    }
    if (rows.some((row) => row.y === y))
      result.push({ url, text: cells.some((cell) => cell.hidden) ? undefined : url, rows });
  }
  return result;
}

function hasId(buffer: IBuffer, row: number, id: number, cols: number): boolean {
  const line = buffer.getLine(row);
  if (!line) return false;
  for (let x = 0; x < cols; x++) if (terminalOscId(line.getCell(x)) === id) return true;
  return false;
}
