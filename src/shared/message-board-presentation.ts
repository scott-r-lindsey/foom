/** Render only named event fields. Stored child records and human notes remain inert data. */
export function childPostText(text: string): string {
  const split = text.indexOf(" · ");
  if (split < 0) return "Child event · ⟨truncated⟩";
  const event = text.slice(0, split);
  let value: unknown;
  try {
    value = JSON.parse(text.slice(split + 3));
  } catch {
    return "Child event · ⟨truncated⟩";
  }
  const record = (input: unknown): Record<string, unknown> =>
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input))
      : {};
  const data = record(value);
  const field = (key: string) => (typeof data[key] === "string" ? data[key] : "");
  const choice = (key: string, choices: string[]) => {
    const item = field(key);
    return choices.includes(item) ? item : "";
  };
  const count = (key: string) => {
    const item = data[key];
    return typeof item === "number" && Number.isSafeInteger(item) && item > 0 ? String(item) : "";
  };
  const automatic = data["automatic"] === true ? " · automatic" : "";
  const verdict = (input: unknown): string => {
    const review = record(input);
    if (review["verdict"] === "clean") return "Clean";
    if (review["verdict"] !== "findings" || !Array.isArray(review["findings"])) return "";
    return review["findings"]
      .slice(0, 10)
      .map((input: unknown) => {
        const finding = record(input);
        if (
          typeof finding["file"] !== "string" ||
          typeof finding["line"] !== "number" ||
          !Number.isSafeInteger(finding["line"]) ||
          finding["line"] < 1 ||
          typeof finding["summary"] !== "string" ||
          typeof finding["scenario"] !== "string"
        )
          return "";
        return `${finding["file"]}:${String(finding["line"])} · ${finding["summary"]}\n${finding["scenario"]}`;
      })
      .filter(Boolean)
      .join("\n\n");
  };
  switch (event) {
    case "launch":
      return `Launched${automatic}${field("prompt") ? `: ${field("prompt")}` : ""}`;
    case "prompt": {
      const prompt = field("text") || field("prompt");
      const body = prompt.startsWith("⟨redacted⟩ reply sent") ? "⟨redacted⟩" : prompt;
      const delivery = choice("delivery", ["delivered", "failed", "indeterminate"]);
      return `Prompt${automatic} · ${body}${delivery ? ` · ${delivery}` : ""}`;
    }
    case "send_keys": {
      const match = /^keys sent \(\d{1,2}\)$/u.exec(field("text"));
      return `Keys sent${match ? field("text").slice(9) : ""} · ${choice("delivery", ["delivered", "failed", "indeterminate"])}`;
    }
    case "handoff":
      return `Handoff · ${choice("status", ["done", "blocked", "failed"])}\n${field("summary")}`;
    case "review verdict":
      return `Review verdict · ${verdict(value)}`;
    case "pull request":
      return `Pull request${count("number") ? ` #${count("number")}` : ""}`;
    case "review loop start":
      return `Review started${count("rounds") ? ` · ${count("rounds")} rounds` : ""}${field("agent") ? ` · ${field("agent")}` : ""}`;
    case "review round start":
      return `Review round${count("round") ? ` ${count("round")}` : ""} started`;
    case "review transition": {
      const phase = choice("phase", [
        "building",
        "reviewing",
        "fixing",
        "waiting-on-parent",
        "clean",
        "escalated",
      ]);
      const reason = choice("reason", [
        "round cap",
        "author blocked",
        "author failed",
        "reviewer blocked",
        "reviewer failed",
        "missing handoff",
        "missing verdict",
        "checks not green",
        "worktree changed",
        "launch failed",
        "resume unavailable",
        "stopped",
        "restored",
      ]);
      return `Review · ${phase}${reason ? ` · ${reason}` : ""}${verdict(data["content"]) ? `\n${verdict(data["content"])}` : ""}`;
    }
    case "findings forwarded":
      return `Findings forwarded\n${verdict(data["content"])}`;
    case "review restored":
      return "Review restored";
    case "review resumed by parent":
      return "Review resumed by parent";
    case "review waiting on parent":
      return "Review waiting on parent";
    case "exit":
      return "Child exited";
    case "stop":
    case "close":
    case "worktree removal": {
      const label = event === "stop" ? "Stop" : event === "close" ? "Close" : "Worktree removal";
      return `${label} · ${choice("status", ["succeeded", "failed", "declined", "cancelled", "indeterminate", "closed", "exited"])}`;
    }
    default:
      return "Child event";
  }
}
