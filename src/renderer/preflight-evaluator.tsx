import { useState } from "react";
import type { ApiProvider, InferenceConfig, ModelCheck } from "../shared/inference";
import type { SetupState } from "../shared/setup";
import { inferenceSummary, PROVIDERS, SAMPLE_TAIL } from "./preflight";
import type { SetupSource } from "./setup-source.d";

type Kind = "api" | "local" | "rules";
type Result =
  | { kind: "running" }
  | { kind: "error"; message: string }
  | { kind: "check"; check: ModelCheck };

/** IPC rejections arrive wrapped; show only main's own message. */
export function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

function outcome(result: Result): { tone: "ok" | "error" | "running"; text: string } {
  if (result.kind === "running") return { tone: "running", text: "Checking…" };
  if (result.kind === "error") return { tone: "error", text: result.message };
  const { check } = result;
  const seconds = `${(check.elapsedMs / 1000).toFixed(1)}s`;
  if (check.status === "model")
    return {
      tone: "ok",
      text: `${check.verdict.state} · confidence ${check.verdict.confidence.toFixed(2)} · ${seconds}. Foom will use this source.`,
    };
  if (check.status === "timeout") return { tone: "error", text: "No answer within 5 seconds." };
  if (check.status === "busy")
    return { tone: "error", text: "Checks are already running. Try again in a moment." };
  return {
    tone: "error",
    text: "That didn't work. Check the model name and key, or that the server is running.",
  };
}

export function EvaluatorStep({
  state,
  source,
  onState,
}: {
  state: SetupState;
  source: SetupSource;
  onState: (state: SetupState) => void;
}) {
  const saved = state.settings.inference;
  const [kind, setKind] = useState<Kind>(
    saved.kind === "rules" ? "rules" : saved.kind === "local" ? "local" : "api",
  );
  const [provider, setProvider] = useState<ApiProvider>(
    saved.kind === "rules" || saved.kind === "local" ? "anthropic" : saved.kind,
  );
  const [models, setModels] = useState<Record<ApiProvider, string>>(() => {
    const defaults = Object.fromEntries(PROVIDERS.map((entry) => [entry.id, entry.model]));
    return {
      anthropic: defaults["anthropic"] ?? "",
      openai: defaults["openai"] ?? "",
      google: defaults["google"] ?? "",
      ...(saved.kind !== "rules" && saved.kind !== "local" ? { [saved.kind]: saved.model } : {}),
    };
  });
  const [endpoint, setEndpoint] = useState(
    saved.kind === "local" ? saved.endpoint : "http://127.0.0.1:11434/v1",
  );
  const [localModel, setLocalModel] = useState(saved.kind === "local" ? saved.model : "");
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [result, setResult] = useState<Result>();
  const hasKey = state.keys[provider];
  const draft: InferenceConfig | undefined =
    kind === "rules"
      ? { kind: "rules" }
      : kind === "local"
        ? localModel.trim()
          ? { kind: "local", model: localModel.trim(), endpoint: endpoint.trim() }
          : undefined
        : models[provider].trim()
          ? { kind: provider, model: models[provider].trim() }
          : undefined;
  const inUse = draft !== undefined && JSON.stringify(draft) === JSON.stringify(saved);

  const fail = (error: unknown) => {
    setResult({ kind: "error", message: message(error) });
  };
  const choose = (next: Kind) => {
    setKind(next);
    setResult(undefined);
    if (next === "rules") source.save({ inference: { kind: "rules" } }).then(onState, fail);
  };
  const run = async () => {
    if (!draft) return;
    setResult({ kind: "running" });
    try {
      const check = await source.check(draft);
      setResult({ kind: "check", check });
      if (check.status === "model") onState(await source.save({ inference: draft }));
    } catch (error) {
      fail(error);
    }
  };
  const saveKey = async () => {
    try {
      onState(await source.setKey(provider, key));
      setKey("");
      setReplacing(false);
      setResult(undefined);
    } catch (error) {
      fail(error);
    }
  };
  const removeKey = async () => {
    try {
      onState(await source.removeKey(provider));
      setResult(undefined);
    } catch (error) {
      fail(error);
    }
  };
  const shown = result && outcome(result);

  return (
    <>
      <div className="preflight-options" role="radiogroup" aria-label="Inference source">
        <label className="preflight-option" data-disabled="true">
          <input type="radio" name="inference" disabled />
          <span>
            <b>Use an agent you already have</b>
            <small>
              Not available yet. Foom can't yet prove that a one-shot agent call sees only the
              terminal tail and never your files, so it won't send anything that way.
            </small>
          </span>
        </label>
        <label className="preflight-option" data-disabled={!state.secureStorage}>
          <input
            type="radio"
            name="inference"
            checked={kind === "api"}
            disabled={!state.secureStorage}
            onChange={() => {
              choose("api");
            }}
          />
          <span>
            <b>Use an API key</b>
            <small>
              {state.secureStorage
                ? "Direct calls to a provider. Fast and cheap per check."
                : "Your system can't encrypt keys for Foom, so API keys are unavailable here."}
            </small>
          </span>
        </label>
        {kind === "api" && (
          <div className="preflight-config">
            <div className="preflight-fields">
              <label>
                Provider
                <select
                  value={provider}
                  onChange={(event) => {
                    const next = PROVIDERS.find((entry) => entry.id === event.target.value);
                    if (next) setProvider(next.id);
                    setResult(undefined);
                    setReplacing(false);
                  }}
                >
                  {PROVIDERS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Model
                <input
                  className="mono"
                  value={models[provider]}
                  spellCheck={false}
                  onChange={(event) => {
                    setModels({ ...models, [provider]: event.target.value });
                    setResult(undefined);
                  }}
                />
              </label>
            </div>
            {hasKey && !replacing ? (
              <p className="preflight-key">
                A key is saved in your system keychain.{" "}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setReplacing(true);
                  }}
                >
                  Replace
                </button>{" "}
                <button type="button" className="link" onClick={() => void removeKey()}>
                  Remove
                </button>
              </p>
            ) : (
              <form
                className="preflight-fields"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveKey();
                }}
              >
                <label>
                  API key
                  <input
                    type="password"
                    autoComplete="off"
                    value={key}
                    placeholder="Paste a key"
                    onChange={(event) => {
                      setKey(event.target.value);
                    }}
                  />
                </label>
                <button type="submit" disabled={!key.trim()}>
                  Save key
                </button>
              </form>
            )}
            <p className="preflight-note">
              Stored in your system keychain. Foom never writes it in plain text or shows it again.
            </p>
          </div>
        )}
        <label className="preflight-option">
          <input
            type="radio"
            name="inference"
            checked={kind === "local"}
            onChange={() => {
              choose("local");
            }}
          />
          <span>
            <b>Use a local model</b>
            <small>Any OpenAI-compatible server on this machine. Nothing leaves it.</small>
          </span>
        </label>
        {kind === "local" && (
          <div className="preflight-config">
            <div className="preflight-fields">
              <label>
                Endpoint
                <input
                  className="mono"
                  value={endpoint}
                  spellCheck={false}
                  onChange={(event) => {
                    setEndpoint(event.target.value);
                    setResult(undefined);
                  }}
                />
              </label>
              <label>
                Model
                <input
                  className="mono"
                  value={localModel}
                  placeholder="qwen3:8b"
                  spellCheck={false}
                  onChange={(event) => {
                    setLocalModel(event.target.value);
                    setResult(undefined);
                  }}
                />
              </label>
            </div>
            <p className="preflight-note">
              Use a loopback address (127.0.0.1 or [::1]) with the API path, as with Ollama, LM
              Studio or vLLM.
            </p>
          </div>
        )}
        <label className="preflight-option">
          <input
            type="radio"
            name="inference"
            checked={kind === "rules"}
            onChange={() => {
              choose("rules");
            }}
          />
          <span>
            <b>Rules only</b>
            <small>No model. Ambiguous terminals stay neutral instead of asking for you.</small>
          </span>
        </label>
      </div>

      {kind !== "rules" && (
        <section className="preflight-test" aria-label="Sample check">
          <div className="preflight-test-head">
            <h3>Try it on a sample</h3>
            <button
              type="button"
              disabled={!draft || result?.kind === "running" || (kind === "api" && !hasKey)}
              onClick={() => void run()}
            >
              Run check
            </button>
          </div>
          <pre className="preflight-tail">{SAMPLE_TAIL}</pre>
          <p className="preflight-result" data-tone={shown?.tone} role="status">
            {shown?.text ??
              (kind === "api" && !hasKey
                ? "Save a key, then run the check."
                : inUse
                  ? "In use. Run the check again any time."
                  : "Not run yet. Foom uses a source only after it passes.")}
          </p>
        </section>
      )}
      {kind === "rules" && result?.kind === "error" && (
        <p className="preflight-result" data-tone="error" role="alert">
          {result.message}
        </p>
      )}
      <p className="preflight-in-use">
        <b>In use:</b> {inferenceSummary(saved)}
      </p>
      <p className="preflight-privacy">
        Foom sends the last 40 lines of a terminal that has gone quiet, with likely secrets
        redacted. It never sends files, diffs, or your keystrokes.
      </p>
    </>
  );
}
