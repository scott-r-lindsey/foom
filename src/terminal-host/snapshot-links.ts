import type { IBuffer, IBufferLine, IBufferCell, Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { terminalLink, terminalOscId, terminalOscTarget } from "../shared/terminal-link";

const refused = "\x1b]8;;foom-refused:\x1b\\";
const close = "\x1b]8;;\x1b\\";
function open(screen: Terminal, id: number): string {
  const target = terminalOscTarget(screen, id);
  const url = terminalLink(target) && typeof target === "string" ? target : "foom-refused:";
  return `\x1b]8;id=foom-${String(id)};${url}\x1b\\`;
}

function rowNumber(value: unknown): number {
  const row = typeof value === "object" && value !== null && "line" in value ? value.line : value;
  if (typeof row !== "number" || !Number.isSafeInteger(row) || row < 0)
    throw new Error("Unsupported xterm row range");
  return row;
}
function rangeRows(range: unknown): { first: number; last: number } {
  if (!range || typeof range !== "object" || !("start" in range) || !("end" in range))
    throw new Error("Unsupported xterm row range");
  const first = rowNumber(range.start),
    last = rowNumber(range.end);
  if (last < first) throw new Error("Unsupported xterm row range");
  return { first, last };
}
function cellId(cell: IBufferCell | undefined): number | undefined {
  return cell?.getChars() ? terminalOscId(cell) : 0;
}
function beforeId(
  buffer: IBuffer,
  row: number,
  col: number,
  first: number,
  cols: number,
): number | undefined {
  if (col === 0) {
    if (row === first || !buffer.getLine(row)?.isWrapped) return 0;
    row--;
    col = cols;
  }
  const line = buffer.getLine(row);
  let x = col - 1;
  let cell = line?.getCell(x);
  // A wide glyph's empty width-zero placeholder is still part of that glyph.
  while (x > 0 && cell?.getWidth() === 0) cell = line?.getCell(--x);
  return cellId(cell);
}
function afterId(
  buffer: IBuffer,
  row: number,
  col: number,
  width: number,
  last: number,
  cols: number,
): number | undefined {
  col += width;
  if (col >= cols) {
    if (row === last || !buffer.getLine(row + 1)?.isWrapped) return 0;
    row++;
    col = 0;
  }
  return cellId(buffer.getLine(row)?.getCell(col));
}

/** Two synchronous read-only passes at the parser barrier: count complete OSC
 * IDs first, then replay each ID wholly retained or wholly inert, preserving
 * consistent target availability across all of its rows.
 */
export function withSnapshotLinks(
  screen: Terminal,
  addon: SerializeAddon,
  serialize: (pen: string) => string,
  budget = 4 * 1024 * 1024,
): string {
  const pen = snapshotLinkPen(screen);
  // Opaque only while replaying. Live output must inherit the real host pen.
  if (budget === 0) return refused + serialize(pen);
  const runs = new Map<number, { count: number; visible: boolean; newest: number }>();
  const openings = new Map<number, string>();
  let planning = true;
  const count = (buffer: IBuffer, first: number, last: number) => {
    const reusable = buffer.getNullCell();
    for (let row = first; row <= last; row++) {
      const line = buffer.getLine(row);
      for (let col = 0; col < screen.cols; col++) {
        const cell = line?.getCell(col, reusable);
        if (!cell || cell.getWidth() === 0) continue;
        const id = cellId(cell);
        if (id) {
          const run = runs.get(id) ?? { count: 0, visible: false, newest: row - buffer.baseY };
          run.visible ||= row >= buffer.baseY && row < buffer.baseY + screen.rows;
          run.newest = Math.max(run.newest, row - buffer.baseY);
          if (beforeId(buffer, row, col, first, screen.cols) !== id) run.count++;
          runs.set(id, run);
        }
      }
    }
  };
  const lineView = (
    buffer: IBuffer,
    line: IBufferLine,
    row: number,
    first: number,
    last: number,
  ): IBufferLine =>
    new Proxy(line, {
      get(target, key): unknown {
        if (key !== "getCell") return Reflect.get(target, key);
        return (col: number, reusable?: IBufferCell) => {
          const cell = target.getCell(col, reusable);
          if (!cell) return undefined;
          const id = terminalOscId(cell);
          if (!id) return cell;
          return new Proxy(cell, {
            get(current, property): unknown {
              if (property !== "getChars") return Reflect.get(current, property);
              return () => {
                const text = current.getChars();
                if (!text) return text;
                const begins = beforeId(buffer, row, col, first, screen.cols) !== id;
                const ends =
                  afterId(buffer, row, col, Math.max(1, current.getWidth()), last, screen.cols) !==
                  id;
                return (begins ? (openings.get(id) ?? refused) : "") + text + (ends ? close : "");
              };
            },
          });
        };
      },
    });
  const bufferView = (buffer: IBuffer, first: number, last: number): IBuffer =>
    new Proxy(buffer, {
      get(target, key): unknown {
        if (key !== "getLine") return Reflect.get(target, key);
        return (row: number) => {
          const line = target.getLine(row);
          return line ? lineView(buffer, line, row, first, last) : undefined;
        };
      },
    });
  const original: unknown = Reflect.get(addon, "_serializeBufferByRange");
  if (typeof original !== "function") throw new Error("Unsupported xterm row serializer");
  const installed = Reflect.set(
    addon,
    "_serializeBufferByRange",
    (terminal: unknown, buffer: IBuffer, ...args: unknown[]) => {
      const { first, last } = rangeRows(args[0]);
      if (planning) count(buffer, first, last);
      const value: unknown = Reflect.apply(original, addon, [
        terminal,
        planning ? buffer : bufferView(buffer, first, last),
        ...args,
      ]);
      if (typeof value !== "string") throw new Error("Unsupported xterm row serialization");
      return value;
    },
  );
  if (!installed) throw new Error("Unsupported xterm row serializer");
  try {
    // The callback is pure serialization; ranges include any cursor-row replay.
    const plain = serialize(pen);
    if (runs.size === 0) return plain;
    let remaining = Math.max(0, budget - (pen === close ? 0 : pen.length));
    // Reserve both visible buffers before history; spend history newest first.
    const ordered = [...runs].sort(
      ([, left], [, right]) =>
        Number(right.visible) - Number(left.visible) || right.newest - left.newest,
    );
    for (const [id, { count }] of ordered) {
      const value = open(screen, id);
      const cost = count * (value.length + close.length);
      if (cost <= remaining) {
        openings.set(id, value);
        remaining -= cost;
      } else openings.set(id, refused);
    }
    planning = false;
    return serialize(pen);
  } finally {
    Reflect.set(addon, "_serializeBufferByRange", original);
  }
}

/** The cursor pen is independent of which historical targets were retained. */
function snapshotLinkPen(screen: Terminal): string {
  const field = (value: unknown, key: string): unknown =>
    value && typeof value === "object" ? Reflect.get(value, key) : undefined;
  const attributes = field(field(field(screen, "_core"), "_inputHandler"), "_curAttrData");
  const id = terminalOscId(attributes);
  return id ? open(screen, id) : close;
}
