import type { ActiveThemeBitmaps } from "../../src/shared/theme-bitmap";

const first = { id: "a".repeat(64), opacity: 0.25, fit: "tile", anchor: "top-left" } as const;
const second = { id: "b".repeat(64), opacity: 0.6, fit: "cover", anchor: "bottom" } as const;

export const artFixture: ActiveThemeBitmaps = {
  theme: "user:fixture.json",
  slots: { empty: [first, second], sidebar: [first], "tile-header": [second] },
};
