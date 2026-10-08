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
  return (
    <section className="agy-plugin preflight-sub" aria-label="Antigravity lifecycle plugin">
      <p>
        Antigravity lifecycle plugin: <strong>{labels[status.state]}</strong>
      </p>
      <p>
        Install adds Foom's observation hooks to Antigravity's user plugin directory (
        <code>~/.gemini/config/plugins/foom</code>) through <code>agy plugin install</code>. They
        report working and turn-end signals, never approval decisions. No credentials are saved in
        the plugin. It returns an empty result and does nothing outside Foom-launched sessions.
      </p>
      <p>
        Remove it here or run <code>agy plugin uninstall foom</code>. Other plugins are unchanged.
        Changes apply to new sessions; without it, Foom uses screen rules and the evaluator.
      </p>
      {status.state === "unavailable" ? (
        <p>Scan again to check the installation. Foom will not replace an unrecognized plugin.</p>
      ) : (
        <div className="preflight-actions">
          {(status.state === "not-installed" || status.state === "outdated") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void change(status.state === "not-installed" ? "install" : "update");
              }}
            >
              {status.state === "not-installed" ? "Install Foom plugin" : "Update Foom plugin"}
            </button>
          )}
          {status.state === "disabled" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void change("enable");
              }}
            >
              Enable Foom plugin
            </button>
          )}
          {status.state !== "not-installed" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void change("remove");
              }}
            >
              Remove Foom plugin
            </button>
          )}
        </div>
      )}
    </section>
  );
}
