/** Coalesce sustained output; a focused terminal always keeps its immediate path. */
export function createOutputWriter(
  write: (data: string, parsed: () => void) => void,
  acknowledge: (id: string, token: string, count: number) => void,
  interactive: () => boolean,
) {
  let frame: number | undefined;
  let pending: { id: string; token: string; data: string; count: number }[] = [];
  const flush = () => {
    if (!pending.length) return false;
    const batch = pending;
    pending = [];
    const acknowledgements = new Map<string, Map<string, number>>();
    for (const { id, token, count } of batch) {
      let tokens = acknowledgements.get(id);
      if (!tokens) {
        tokens = new Map();
        acknowledgements.set(id, tokens);
      }
      tokens.set(token, (tokens.get(token) ?? 0) + count);
    }
    write(batch.map((chunk) => chunk.data).join(""), () => {
      for (const [id, tokens] of acknowledgements)
        for (const [token, count] of tokens) acknowledge(id, token, count);
    });
    return true;
  };
  const tick = () => {
    frame = undefined;
    flush();
  };
  return {
    write: (id: string, token: string, data: string, exited = false) => {
      pending.push({ id, token, data: exited ? `${data}\x1b[?25l` : data, count: data.length });
      // Keyboard input always belongs to the focused terminal, which never
      // waits for a frame. Other visible streams coalesce until their next frame.
      if (interactive()) {
        flush();
        return;
      }
      if (frame === undefined) frame = requestAnimationFrame(tick);
    },
    flush,
    dispose: () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      pending = [];
    },
  };
}
