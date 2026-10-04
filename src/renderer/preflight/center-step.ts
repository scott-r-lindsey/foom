/** CSS owns centering and overflow; animate only same-step height changes. */
export function centerStep(stage: HTMLElement, inner: HTMLElement): () => void {
  let previousHeight = inner.getBoundingClientRect().height;
  let previousStageHeight = stage.getBoundingClientRect().height;
  let animation: Animation | undefined;
  const observer = new ResizeObserver(() => {
    const bounds = inner.getBoundingClientRect();
    const stageBounds = stage.getBoundingClientRect();
    const height = bounds.height;
    const stageHeight = stageBounds.height;
    const scale = height / inner.offsetHeight;
    const before = Math.max(0, (previousStageHeight - previousHeight) / 2);
    const after = Math.max(0, (stageHeight - height) / 2);
    // Preserve the current visual position if another update interrupts a move.
    const visualOffset = bounds.top - stageBounds.top;
    const offset = before - after + (animation?.playState === "running" ? visualOffset - after : 0);
    animation?.cancel();
    if (
      offset !== 0 &&
      stageHeight === previousStageHeight &&
      previousHeight <= stageHeight &&
      height <= stageHeight &&
      stage.scrollTop === 0 &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      // Keep both ends inside the stage throughout the move; transforms must not
      // introduce a temporary scrollbar even when the final layout fits.
      animation = inner.animate(
        [
          {
            transform: `translateY(${String(Math.min(after, Math.max(-after, offset)) / scale)}px)`,
          },
          { transform: "translateY(0)" },
        ],
        { duration: 180, easing: "ease-out" },
      );
    }
    previousHeight = height;
    previousStageHeight = stageHeight;
  });
  observer.observe(inner);
  observer.observe(stage);
  return () => {
    observer.disconnect();
    animation?.cancel();
  };
}
