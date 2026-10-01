import type { ReactNode, RefObject } from "react";
import type { SettingsPatch } from "../../shared/setup";

export interface StepHeading {
  headingRef: RefObject<HTMLHeadingElement | null>;
}

/** Navigation and persistence remain owned by the preflight coordinator. */
export interface StepActions {
  nav: (back: number | undefined, why: string, next?: number) => ReactNode;
  save: (patch: SettingsPatch) => void;
}
