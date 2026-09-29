import type { DesktopApi } from '../shared/desktop';

declare global {
  interface Window {
    readonly desktop: DesktopApi;
  }
}
