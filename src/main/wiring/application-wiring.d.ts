import type { runApplication } from "./application";

/** Live application bindings shared by feature wiring; not renderer capabilities. */
export type ApplicationWiring = ReturnType<typeof runApplication>;
