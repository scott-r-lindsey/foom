/** One shared, conservative scale: enlarge only while the rendered controls fit. */
export function scalePreflight(
  viewport: HTMLElement,
  content: HTMLElement,
  stage: HTMLElement,
  inner: HTMLElement,
): () => void {
  let width = -1;
  let height = -1;
  let ceiling = 2;
  let frame = 0;
  const update = () => {
    frame = 0;
    // CSS pixels already include interface zoom. Never add that magnification again.
    if (width !== viewport.clientWidth || height !== viewport.clientHeight) {
      width = viewport.clientWidth;
      height = viewport.clientHeight;
      ceiling = Math.max(1, Math.min(2, width / 1040, height / 840));
    }
    if (width === 0 || height === 0) return;
    const top = stage.scrollTop;
    const fits = (scale: number) => {
      content.style.zoom = String(scale);
      return (
        Math.max(inner.offsetHeight, inner.scrollHeight) <= stage.clientHeight - 2 &&
        inner.scrollWidth <= stage.clientWidth
      );
    };
    // Keep a shared ceiling across steps and streaming updates. Only a viewport
    // change permits growth again, avoiding repeated zooming as results appear/disappear.
    if (!fits(ceiling)) {
      let low = 1;
      let high = ceiling;
      if (fits(low)) {
        // A bounded search handles wrapping, column changes, padding and the footer.
        for (let attempt = 0; attempt < 8; attempt++) {
          const middle = (low + high) / 2;
          if (fits(middle)) low = middle;
          else high = middle;
        }
      }
      ceiling = low;
      content.style.zoom = String(ceiling);
    }
    stage.scrollTop = top;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  update();
  const observer = new ResizeObserver(schedule);
  for (const element of [viewport, stage, inner]) observer.observe(element);
  // Details, text and step changes can overflow without changing the outer box.
  const mutations = new MutationObserver(schedule);
  mutations.observe(content, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["open"],
  });
  document.fonts.addEventListener("loadingdone", schedule);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    mutations.disconnect();
    document.fonts.removeEventListener("loadingdone", schedule);
  };
}
