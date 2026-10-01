import type { DesktopApi } from "../shared/desktop";

declare global {
  const FOOM_SAMPLE_BOARD: boolean;
  interface Window {
    readonly desktop: DesktopApi;
  }
}
