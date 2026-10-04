import type { RefObject } from "react";
import type { SettingsPatch } from "../../shared/setup";

export interface StepHeading {
  headingRef: RefObject<HTMLHeadingElement | null>;
}

/** Persistence remains owned by the preflight coordinator. */
export interface StepActions {
  save: (patch: SettingsPatch) => void;
}
