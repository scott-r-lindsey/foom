import type { Terminal } from "@xterm/xterm";

/** Main's headless screen answers these queries; views only render their output. */
export function suppressTerminalReplies(terminal: Pick<Terminal, "parser">): void {
  for (const id of [
    { final: "c" },
    { prefix: ">", final: "c" },
    { final: "n" },
    { prefix: "?", final: "n" },
    { intermediates: "$", final: "p" },
    { prefix: "?", intermediates: "$", final: "p" },
  ]) {
    terminal.parser.registerCsiHandler(id, () => true);
  }
  terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, () => true);
}
