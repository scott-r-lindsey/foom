import type { IBuffer, Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";

function cursorSnapshot(screen: Terminal): string {
  // DECSCUSR overrides the options in xterm 6, but neither the public modes API
  // nor addon-serialize exposes it. Check the pinned representation as we do
  // for scrolling margins; reading options alone loses application cursor styles.
  const field = (value: unknown, key: string): unknown => {
    if (typeof value !== "object" || value === null || !(key in value))
      throw new Error("Unsupported xterm cursor state");
    return Reflect.get(value, key);
  };
  const modes = field(field(field(screen, "_core"), "coreService"), "decPrivateModes");
  const blink = field(modes, "cursorBlink");
  const style = field(modes, "cursorStyle");
  if (
    (blink !== undefined && typeof blink !== "boolean") ||
    (style !== undefined && style !== "block" && style !== "underline" && style !== "bar")
  )
    throw new Error("Unsupported xterm cursor state");
  const effectiveStyle = style ?? screen.options.cursorStyle;
  const base = effectiveStyle === "bar" ? 5 : effectiveStyle === "underline" ? 3 : 1;
  const code =
    style === undefined && blink === undefined
      ? 0
      : base + ((blink ?? screen.options.cursorBlink) ? 0 : 1);
  // Preserve the option separately: CSI 0 SP q must still return to it, and
  // subsequent DEC mode 12 changes must work when DECSCUSR has no override.
  return `\x1b[?12${screen.options.cursorBlink ? "h" : "l"}\x1b[${String(code)} q`;
}

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
function snapshot(screen: Terminal, serialize: SerializeAddon, scrollback?: number): string {
  const cursor = cursorSnapshot(screen);
  const options = scrollback === undefined ? {} : { scrollback };
  const snapshot = serialize.serialize(options);
  const active = screen.buffer.active;
  if (active.type === "normal")
    return snapshot + restore(screen, serialize, active, screen.modes.originMode) + cursor;
  const normal = serialize.serialize({ ...options, excludeAltBuffer: true, excludeModes: true });
  // Restore the inactive normal buffer before 1049h saves its cursor. The active
  // alternate buffer and modes are then serialized in their original order.
  return (
    normal +
    restore(screen, serialize, screen.buffer.normal, false) +
    snapshot.slice(normal.length) +
    restore(screen, serialize, active, screen.modes.originMode) +
    cursor
  );
}

/** Reduce only replayed history; both visible buffers and the host's history stay intact. */
export function terminalSnapshot(
  screen: Terminal,
  serialize: SerializeAddon,
  fits?: (data: string) => boolean,
): string {
  let scrollback: number | undefined;
  for (;;) {
    const data = snapshot(screen, serialize, scrollback);
    if (!fits || fits(data)) return data;
    if (scrollback === 0) throw new Error("Visible terminal exceeds snapshot budget");
    // One fallback bounds reserialization work and preserves both visible buffers.
    scrollback = 0;
  }
}
