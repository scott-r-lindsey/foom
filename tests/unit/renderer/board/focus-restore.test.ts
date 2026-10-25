// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { restoreBoardFocus } from "../../../../src/renderer/board/focus-restore";

afterEach(() => {
  document.body.replaceChildren();
});

test("restores the exact input and falls back when it was closed or cannot take focus", () => {
  document.body.innerHTML =
    '<input id="origin"><section class="terminal-tile" data-focused="true" tabindex="0"><textarea class="xterm-helper-textarea"></textarea></section><aside class="sidebar-shell"><button role="treeitem">Session</button><button class="wordmark-menu">Foom</button></aside>';
  const previous = document.querySelector("input");
  restoreBoardFocus(previous);
  expect(document.activeElement).toBe(previous);
  previous?.setAttribute("hidden", "");
  restoreBoardFocus(previous);
  expect(document.activeElement).toBe(document.querySelector("textarea"));
  previous?.remove();
  restoreBoardFocus(previous);
  expect(document.activeElement).toBe(document.querySelector("textarea"));
  document.querySelector("textarea")?.remove();
  restoreBoardFocus(document.body);
  expect(document.activeElement).toBe(document.querySelector("section"));
  document.querySelector("section")?.remove();
  restoreBoardFocus(document.createElement("input"));
  expect(document.activeElement).toBe(document.querySelector('[role="treeitem"]'));
  document.querySelector('[role="treeitem"]')?.remove();
  restoreBoardFocus(null);
  expect(document.activeElement).toBe(document.querySelector("button"));
  document.querySelector("button")?.setAttribute("disabled", "");
  const unfocusable = document.createElement("div");
  document.body.append(unfocusable);
  restoreBoardFocus(unfocusable);
});
