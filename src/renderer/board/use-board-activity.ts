import { useEffect } from "react";
import { waitTime } from "./board";
import type { BoardSource } from "./board-source.d";
import { subscribeLights } from "./light-activity";

import type { RefObject } from "react";
export function useBoardActivity(
  source: BoardSource,
  buttonsRef: RefObject<Map<string, HTMLElement>>,
) {
  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      timer = undefined;
      const now = Date.now();
      let delay = Infinity;
      for (const row of source.getSnapshot()) {
        const element = buttonsRef.current.get(row.id)?.querySelector(".board-wait");
        if (!element) continue;
        const text = waitTime(row, now);
        if (element.textContent !== text) element.textContent = text;
        if (row.state !== "needs_input") continue;
        const elapsed = Math.max(0, now - row.waitingSince);
        const unit = elapsed < 60000 ? 1000 : 60000;
        delay = Math.min(delay, unit - (elapsed % unit));
      }
      if (Number.isFinite(delay)) timer = window.setTimeout(update, delay);
    };
    const wake = () => {
      window.clearTimeout(timer);
      // Let React commit newly mounted wait labels before reading the refs.
      timer = window.setTimeout(update, 0);
    };
    const off = source.subscribe(wake);
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.target instanceof Element &&
            !record.target.closest(".xterm, .tile-terminal") &&
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches(".board-wait") || node.querySelector(".board-wait")),
            ),
        )
      )
        wake();
    });
    observer.observe(document.querySelector(".sidebar-shell") ?? document.body, {
      childList: true,
      subtree: true,
    });
    update();
    return () => {
      off();
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [source, buttonsRef]);
  useEffect(
    () =>
      subscribeLights(
        source,
        () =>
          source.getSnapshot().flatMap((row) => {
            const button = buttonsRef.current.get(row.id);
            const element = button?.querySelector<HTMLElement>(".board-light");
            return element
              ? [
                  {
                    row,
                    element,
                    trace: button?.querySelector<SVGPathElement>(".activity-trace path"),
                  },
                ]
              : [];
          }),
        document.querySelector(".sidebar-shell") ?? document.body,
      ),
    [source, buttonsRef],
  );
}
