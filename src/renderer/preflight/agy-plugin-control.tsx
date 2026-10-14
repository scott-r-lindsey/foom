import type { AgyPluginAction, AgyPluginStatus } from "../../shared/agy-plugin";

const labels = {
  "not-installed": "Not installed",
  installed: "Installed",
  outdated: "Outdated",
  disabled: "Disabled",
  unavailable: "Status unavailable",
} as const;

export function AgyPluginControl({
  status,
  busy,
  change,
}: {
  status: AgyPluginStatus;
  busy: boolean;
  change: (action: AgyPluginAction) => Promise<void>;
}) {
  const action =
    status.state === "not-installed"
      ? "install"
      : status.state === "outdated"
        ? "update"
        : status.state === "disabled"
          ? "enable"
          : undefined;
  return (
    <div className="agy-plugin" aria-label="Antigravity lifecycle plugin">
      <span>Lifecycle plugin · {labels[status.state]}</span>
      {action && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void change(action);
          }}
        >
          {action === "install"
            ? "Install plugin"
            : action === "update"
              ? "Update plugin"
              : "Enable plugin"}
        </button>
      )}
      {["installed", "outdated", "disabled"].includes(status.state) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void change("remove");
          }}
        >
          Remove plugin
        </button>
      )}
    </div>
  );
}
