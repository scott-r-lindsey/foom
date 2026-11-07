import type { IBuffer, IBufferLine, IBufferCell, Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { terminalLink, terminalOscId, terminalOscTarget } from "../shared/terminal-link";

export class SnapshotLinkBudget extends Error {}

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
  serialize: () => string,
): string {
  const starts = new Map<number, string>();
  let remaining = 4 * 1024 * 1024;
  const start = (id: number) => {
    let value = starts.get(id);
    if (!value) {
      value = open(screen, id);
      starts.set(id, value);
    }
    remaining -= value.length;
    if (remaining < 0) throw new SnapshotLinkBudget("Terminal link snapshot exceeds budget");
    return value;
  };
  const lineView = (line: IBufferLine): IBufferLine =>
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
                return (begins ? start(id) : "") + text + (ends ? close : "");
              };
            },
          });
        };
      },
    });
  const bufferView = (buffer: IBuffer): IBuffer =>
    new Proxy(buffer, {
      get(target, key): unknown {
        if (key !== "getLine") return Reflect.get(target, key);
        return (row: number) => {
          const line = target.getLine(row);
          return line ? lineView(line) : undefined;
        };
      },
    });
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
    return serialize();
  } finally {
    Reflect.set(addon, "_serializeBufferByRange", original);
  }
}

/** Preserve an OSC run left open across the snapshot/live-output boundary. */
export function snapshotLinkPen(screen: Terminal): string {
  const field = (value: unknown, key: string): unknown =>
    value && typeof value === "object" ? Reflect.get(value, key) : undefined;
  const attributes = field(field(field(screen, "_core"), "_inputHandler"), "_curAttrData");
  const id = terminalOscId(attributes);
  return id ? open(screen, id) : close;
}
