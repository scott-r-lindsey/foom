import type { IBuffer, IBufferLine, IBufferCell, Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { terminalLink, terminalOscId, terminalOscTarget } from "../shared/terminal-link";

const refused = "\x1b]8;;foom-refused:\x1b\\";
const close = "\x1b]8;;\x1b\\";
function open(screen: Terminal, id: number): string {
  const target = terminalOscTarget(screen, id);
  // Refused OSC labels must stay opaque rather than turning into plain web links on replay.
  const url = terminalLink(target) && typeof target === "string" ? target : "foom-refused:";
  return `\x1b]8;id=foom-${String(id)};${url}\x1b\\`;
}

/** The pinned serializer uses getChars only for emptiness and emitted glyphs.
 * A scoped buffer facade adds OSC boundaries to printed runs without changing
 * cells, SGR, widths, cursor accounting, wrap metadata or the headless screen.
 */
export function withSnapshotLinks(
  screen: Terminal,
  addon: SerializeAddon,
  serialize: (pen: string) => string,
  budget = 4 * 1024 * 1024,
): string {
  // Last transport fallback: one opaque run for the replay, rather than adding
  // per-cell inert markers that could themselves exceed a wire-size limit.
  if (budget === 0) return refused + serialize(refused);
  const starts = new Map<number, string>();
  let remaining = budget;
  const start = (id: number) => {
    let value = starts.get(id);
    if (!value) {
      value = open(screen, id);
    }
    // Reserve an opening and its closer once per emitted run, never per getChars
    // call. The serializer reads glyphs both to test emptiness and to emit them.
    if (remaining < value.length + close.length) return refused;
    starts.set(id, value);
    remaining -= value.length + close.length;
    return value;
  };
  const lineView = (line: IBufferLine, row: number, openings: Map<number, string>): IBufferLine =>
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
                const before = target.getCell(col - 1);
                const after = target.getCell(col + Math.max(1, current.getWidth()));
                const begins = col === 0 || terminalOscId(before) !== id || !before?.getChars();
                const ends = terminalOscId(after) !== id || !after?.getChars();
                let opening = "";
                if (begins) {
                  const key = row * screen.cols + col;
                  const existing = openings.get(key);
                  opening = existing ?? start(id);
                  if (existing === undefined) openings.set(key, opening);
                }
                return opening + text + (ends ? close : "");
              };
            },
          });
        };
      },
    });
  const bufferView = (buffer: IBuffer): IBuffer => {
    const openings = new Map<number, string>();
    return new Proxy(buffer, {
      get(target, key): unknown {
        if (key !== "getLine") return Reflect.get(target, key);
        return (row: number) => {
          const line = target.getLine(row);
          return line ? lineView(line, row, openings) : undefined;
        };
      },
    });
  };
  // No wrapper survives this synchronous parser barrier, including a failed serialization.
  const original: unknown = Reflect.get(addon, "_serializeBufferByRange");
  if (typeof original !== "function") throw new Error("Unsupported xterm row serializer");
  const installed = Reflect.set(
    addon,
    "_serializeBufferByRange",
    (terminal: unknown, buffer: IBuffer, ...args: unknown[]) => {
      const value: unknown = Reflect.apply(original, addon, [
        terminal,
        bufferView(buffer),
        ...args,
      ]);
      if (typeof value !== "string") throw new Error("Unsupported xterm row serialization");
      return value;
    },
  );
  if (!installed) throw new Error("Unsupported xterm row serializer");
  try {
    return serialize(snapshotLinkPen(screen, start));
  } finally {
    Reflect.set(addon, "_serializeBufferByRange", original);
  }
}

/** Preserve an OSC run left open across the snapshot/live-output boundary. */
function snapshotLinkPen(screen: Terminal, start: (id: number) => string): string {
  const field = (value: unknown, key: string): unknown =>
    value && typeof value === "object" ? Reflect.get(value, key) : undefined;
  const attributes = field(field(field(screen, "_core"), "_inputHandler"), "_curAttrData");
  const id = terminalOscId(attributes);
  return id ? start(id) : close;
}
