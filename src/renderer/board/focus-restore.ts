/** Restore DOM input focus without activating the native window. */
export function restoreBoardFocus(previous: Element | null): void {
  const focus = (target: Element | null) => {
    if (
      !(target instanceof HTMLElement) ||
      !target.isConnected ||
      target === document.body ||
      target.closest("[hidden], [inert]") ||
      target.matches(":disabled")
    )
      return false;
    target.focus({ preventScroll: true });
    return document.activeElement === target;
  };
  if (focus(previous)) return;
  // The original terminal or menu anchor may have closed during the modal.
  for (const selector of [
    '.terminal-tile[data-focused="true"] .xterm-helper-textarea',
    '.terminal-tile[data-focused="true"]',
    ".sidebar-shell [data-nav]",
    ".wordmark-menu",
    ".board-list",
  ]) {
    for (const target of document.querySelectorAll(selector)) if (focus(target)) return;
  }
}
