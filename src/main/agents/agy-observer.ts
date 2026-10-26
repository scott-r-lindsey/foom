import { agyMcpFiles } from "./agy-mcp";
import { orderedObserverFiles } from "./ordered-observer";
/**
 * Static observer assets; no credentials or installation-specific paths in the plugin.
 * Version 4 adds an environment-only MCP launcher.
 */
export const AGY_PLUGIN_VERSION = 4;

export function agyPluginFiles(platform: NodeJS.Platform): Record<string, string> {
  const command =
    platform === "win32"
      ? "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./observer.ps1"
      : "sh ./observer.sh";
  const handler = (event: string) => ({
    type: "command",
    command: `${command} ${event}`,
    timeout: 3,
  });
  return {
    "plugin.json": JSON.stringify({
      name: "foom",
      version: "1.0.0",
      foomObserverVersion: AGY_PLUGIN_VERSION,
    }),
    "hooks.json": JSON.stringify({
      "foom-observer-v1": {
        PreInvocation: [handler("PreInvocation")],
        PostToolUse: [{ matcher: "*", hooks: [handler("PostToolUse")] }],
        Stop: [handler("Stop")],
      },
    }),
    ...orderedObserverFiles(),
    ...agyMcpFiles(platform === "win32", "."),
  };
}
