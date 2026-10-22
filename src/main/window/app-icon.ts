import * as path from "node:path";

/**
 * BrowserWindow icon options. Linux window managers take the icon from the window;
 * macOS and Windows use the bundle and executable icons that packaging installs.
 */
export function windowIcon(platform: NodeJS.Platform, buildRoot: string): { icon?: string } {
  return platform === "linux" ? { icon: path.join(buildRoot, "icons", "foom-512.png") } : {};
}
