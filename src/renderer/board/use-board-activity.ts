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
    const timer = window.setInterval(() => {
      for (const row of source.getSnapshot()) {
        const element = buttonsRef.current.get(row.id)?.querySelector(".board-wait");
        if (element) element.textContent = waitTime(row, Date.now());
      }
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [source, buttonsRef]);
  useEffect(
    () =>
      subscribeLights(source, () =>
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
      ),
    [source, buttonsRef],
  );
}
