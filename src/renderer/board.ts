export type BoardState = "working" | "checking" | "needs_input" | "done" | "failed" | "quiet_ok";
export interface BoardRow {
  id: string;
  repository: string;
  branch: string;
  agent: string;
  state: BoardState;
  reason: string;
  rate: number;
  waitingSince: number;
  seen: boolean;
  tail: string[];
}

const labels: Record<BoardState, string> = {
  working: "Working",
  checking: "Checking",
  needs_input: "Needs you",
  done: "Done",
  failed: "Failed",
  quiet_ok: "Quiet",
};
export function light(row: BoardRow): { label: string; opacity: number } {
  let opacity = 1;
  if (row.state === "working") opacity = 0.35 + 0.65 * Math.min(1, Math.max(0, row.rate) / 4000);
  if (row.state === "quiet_ok" || ((row.state === "done" || row.state === "failed") && row.seen))
    opacity = 0.4;
  return { label: labels[row.state], opacity };
}
export function nextWaiting(rows: readonly BoardRow[]): BoardRow | undefined {
  return rows
    .filter((row) => row.state === "needs_input")
    .sort((a, b) => a.waitingSince - b.waitingSince)[0];
}
export function waitTime(row: BoardRow, now: number): string {
  if (row.state !== "needs_input") return "—";
  const seconds = Math.max(0, Math.floor((now - row.waitingSince) / 1000));
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m`;
}
export function sampleRows(now: number): BoardRow[] {
  return [
    {
      id: "review",
      repository: "foom",
      branch: "fix/session-restore",
      agent: "Claude Code",
      state: "needs_input",
      reason: "Wants permission to run tests · hook: permission",
      rate: 0,
      waitingSince: now - 184000,
      seen: false,
      tail: ["Ready to verify session restore.", "Run npm test? (y/n)"],
    },
    {
      id: "build",
      repository: "foom",
      branch: "feat/terminal-tabs",
      agent: "Codex",
      state: "working",
      reason: "Building terminal navigation",
      rate: 2200,
      waitingSince: now,
      seen: false,
      tail: ["Checking keyboard navigation…", "Building renderer"],
    },
    {
      id: "check",
      repository: "foom",
      branch: "fix/resize",
      agent: "Antigravity",
      state: "checking",
      reason: "Output stopped · checking last lines",
      rate: 0,
      waitingSince: now,
      seen: false,
      tail: ["Resize tests complete.", "Reviewing results…"],
    },
    {
      id: "done",
      repository: "observatory",
      branch: "docs/setup",
      agent: "Claude Code",
      state: "done",
      reason: "Finished successfully · exit: 0",
      rate: 0,
      waitingSince: now,
      seen: false,
      tail: ["Documentation updated.", "Process exited (0)"],
    },
    {
      id: "failed",
      repository: "observatory",
      branch: "fix/search",
      agent: "Codex",
      state: "failed",
      reason: "Tests failed · exit: 1",
      rate: 0,
      waitingSince: now,
      seen: false,
      tail: ["FAIL search returns matching results", "Process exited (1)"],
    },
    {
      id: "server",
      repository: "observatory",
      branch: "feat/dashboard",
      agent: "Shell",
      state: "quiet_ok",
      reason: "Development server is ready",
      rate: 0,
      waitingSince: now,
      seen: false,
      tail: ["Server listening on localhost:3000", "Ready"],
    },
    {
      id: "approve",
      repository: "observatory",
      branch: "feat/export",
      agent: "Claude Code",
      state: "needs_input",
      reason: "Waiting for approval · pattern: (y/n)",
      rate: 0,
      waitingSince: now - 45000,
      seen: false,
      tail: ["Export is ready.", "Continue? (y/n)"],
    },
  ];
}

/** Sample-only adapter; no fixture ID is ever sent to the terminal bridge. */
export function mountBoard(host: HTMLElement, rows: BoardRow[]) {
  const dialog = document.createElement("dialog");
  dialog.className = "board-dialog";
  dialog.setAttribute("aria-label", "Sample board");
  dialog.innerHTML = `<div class="board-top"><div><h1>Mission control</h1><p>Sample board · Simulated sessions</p></div><button type="button" data-close>Return to shell</button></div><p class="board-help">↑ ↓ select · P peek · Enter open · Esc hide · N next waiting</p><div class="board-list"></div><aside class="board-peek" aria-label="Terminal peek" hidden><h2></h2><pre></pre></aside><section class="board-terminal" aria-label="Sample terminal" tabindex="-1" hidden><button type="button" data-hide>Hide terminal</button><h2></h2><pre></pre><p>Sample output. No commands are executed.</p><button type="button" data-reply>Simulate reply</button><button type="button" data-dismiss>Not attention</button></section><p class="board-summary" role="status"></p>`;
  host.append(dialog);
  // All queried elements come from the fixed template above.
  const list = dialog.querySelector<HTMLDivElement>(".board-list");
  const peek = dialog.querySelector<HTMLElement>(".board-peek");
  const terminal = dialog.querySelector<HTMLElement>(".board-terminal");
  const summary = dialog.querySelector<HTMLElement>(".board-summary");
  if (!list || !peek || !terminal || !summary) throw new Error("Missing board elements");
  const buttons = new Map<string, HTMLButtonElement>();
  let selected = rows[0];
  let opened: BoardRow | undefined;
  const paint = () => {
    for (const row of rows) {
      const button = buttons.get(row.id);
      if (!button) continue;
      const signal = light(row);
      button.dataset["state"] = row.state;
      button.style.setProperty("--light-opacity", String(signal.opacity));
      button.tabIndex = row === selected ? 0 : -1;
      button.setAttribute("aria-current", String(row === selected));
      const fields: [string, string][] = [
        ["board-branch", row.branch],
        ["board-agent", row.agent],
        ["board-state", signal.label],
        ["board-wait", waitTime(row, Date.now())],
        ["board-reason", row.reason],
      ];
      for (const [className, text] of fields) {
        const span = button.querySelector(`.${className}`);
        if (span) span.textContent = text;
      }
    }
    const waiting = rows.filter((row) => row.state === "needs_input").length;
    summary.textContent = waiting
      ? `${String(waiting)} ${waiting === 1 ? "session needs" : "sessions need"} you.`
      : "Nothing needs you. Yet.";
  };
  const showTail = (panel: HTMLElement, row: BoardRow) => {
    const heading = panel.querySelector("h2");
    const output = panel.querySelector("pre");
    if (heading) heading.textContent = `${row.agent} · ${row.branch}`;
    if (output) output.textContent = row.tail.join("\n");
    panel.hidden = false;
  };
  const hide = () => {
    terminal.hidden = true;
    peek.hidden = true;
    opened = undefined;
    if (selected) buttons.get(selected.id)?.focus();
  };
  const open = (row: BoardRow) => {
    selected = row;
    opened = row;
    row.seen = true;
    peek.hidden = true;
    showTail(terminal, row);
    for (const button of terminal.querySelectorAll<HTMLButtonElement>(
      "[data-reply], [data-dismiss]",
    ))
      button.disabled = row.state !== "needs_input";
    paint();
    terminal.focus();
  };
  const groups = new Map<string, HTMLElement>();
  for (const row of rows) {
    let group = groups.get(row.repository);
    if (!group) {
      group = document.createElement("section");
      const heading = document.createElement("h2");
      heading.textContent = row.repository;
      group.append(heading);
      list.append(group);
      groups.set(row.repository, group);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "board-row";
    // Keep the light mounted across timer ticks so its animation and transitions continue.
    button.innerHTML =
      '<span class="board-light" aria-hidden="true"></span><span class="board-branch"></span><span class="board-agent"></span><span class="board-state"></span><span class="board-wait"></span><span class="board-reason"></span>';
    button.addEventListener("focus", () => {
      selected = row;
      paint();
    });
    button.addEventListener("click", () => {
      open(row);
    });
    button.addEventListener("mouseenter", () => {
      if (!opened) showTail(peek, row);
    });
    button.addEventListener("mouseleave", () => {
      peek.hidden = true;
    });
    group.append(button);
    buttons.set(row.id, button);
  }
  dialog.querySelector("[data-close]")?.addEventListener("click", () => {
    dialog.close();
  });
  dialog.querySelector("[data-hide]")?.addEventListener("click", hide);
  const resolve = (action: string) => {
    if (!opened || opened.state !== "needs_input") return;
    opened.state = "working";
    opened.reason = action;
    paint();
    hide();
  };
  dialog.querySelector("[data-reply]")?.addEventListener("click", () => {
    resolve("Sample reply sent");
  });
  dialog.querySelector("[data-dismiss]")?.addEventListener("click", () => {
    resolve("Not attention · dismissed");
  });
  dialog.addEventListener("cancel", (event) => {
    if (opened || !peek.hidden) {
      event.preventDefault();
      hide();
    }
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape" && (opened || !peek.hidden)) {
      event.preventDefault();
      hide();
    } else if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      const next = nextWaiting(rows);
      if (next) open(next);
    } else if (!opened && selected) {
      const index = rows.indexOf(selected);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next =
          rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length];
        if (next) buttons.get(next.id)?.focus();
      } else if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        if (peek.hidden) showTail(peek, selected);
        else peek.hidden = true;
      }
    }
  });
  paint();
  const timer = window.setInterval(() => {
    if (dialog.open) paint();
  }, 1000);
  return {
    show: () => {
      dialog.showModal();
      if (selected) buttons.get(selected.id)?.focus();
    },
    dispose: () => {
      window.clearInterval(timer);
      dialog.remove();
    },
  };
}
