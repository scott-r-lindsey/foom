import type { IBuffer, Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";

function restore(
  screen: Terminal,
  serialize: SerializeAddon,
  buffer: IBuffer,
  origin: boolean,
): string {
  const { rows, cols } = screen;
  // xterm 6 exposes cells/cursors publicly, but not DECSTBM. Keep this dependency
  // on its pinned BufferApiView isolated and checked; never silently lose margins.
  const internal: unknown = "_buffer" in buffer ? buffer._buffer : undefined;
  if (
    typeof internal !== "object" ||
    internal === null ||
    !("scrollTop" in internal) ||
    !("scrollBottom" in internal) ||
    typeof internal.scrollTop !== "number" ||
    typeof internal.scrollBottom !== "number" ||
    !Number.isInteger(internal.scrollTop) ||
    !Number.isInteger(internal.scrollBottom) ||
    internal.scrollTop < 0 ||
    internal.scrollBottom >= rows ||
    internal.scrollTop >= internal.scrollBottom
  )
    throw new Error("Unsupported xterm scrolling-region state");
  const { scrollTop, scrollBottom } = internal;
  if (scrollTop === 0 && scrollBottom === rows - 1 && !origin) return "";
  // DECSTBM and DECOM both home the cursor. Restore margins, then origin mode,
  // then the cursor using coordinates relative to that origin.
  const margins = `\x1b[?6l\x1b[${String(scrollTop + 1)};${String(scrollBottom + 1)}r${origin ? "\x1b[?6h" : ""}\x1b[${String(buffer.cursorY + 1 - (origin ? scrollTop : 0))};${String(buffer.cursorX + 1)}H`;
  if (buffer.cursorX < cols) return margins;
  // CUP cannot represent pending autowrap. Replay the cursor row after restoring
  // margins; the final printable cell leaves x === cols without scrolling. Use
  // the pinned addon's row serializer to preserve wide cells, SGR and the current
  // pen. Its public range option only supports the normal buffer.
  if (
    !("_serializeBufferByRange" in serialize) ||
    typeof serialize._serializeBufferByRange !== "function"
  )
    throw new Error("Unsupported xterm row serializer");
  const row = buffer.baseY + buffer.cursorY;
  const replay: unknown = Reflect.apply(serialize._serializeBufferByRange, serialize, [
    screen,
    buffer,
    { start: row, end: row },
    true,
  ]);
  if (typeof replay !== "string") throw new Error("Unsupported xterm row serialization");
  // Serialization assumes a default pen and overwrite mode. Restore insert mode
  // after replay, without issuing another cursor movement that clears the wrap.
  return `${margins}\r\x1b[0m\x1b[4l${replay}${buffer.type === screen.buffer.active.type && screen.modes.insertMode ? "\x1b[4h" : ""}`;
}

/** Called at the host parser barrier, before any subsequent live output. */
export function terminalSnapshot(screen: Terminal, serialize: SerializeAddon): string {
  const snapshot = serialize.serialize();
  const active = screen.buffer.active;
  if (active.type === "normal")
    return snapshot + restore(screen, serialize, active, screen.modes.originMode);
  const normal = serialize.serialize({ excludeAltBuffer: true, excludeModes: true });
  // Restore the inactive normal buffer before 1049h saves its cursor. The active
  // alternate buffer and modes are then serialized in their original order.
  return (
    normal +
    restore(screen, serialize, screen.buffer.normal, false) +
    snapshot.slice(normal.length) +
    restore(screen, serialize, active, screen.modes.originMode)
  );
}
