import { useEffect, useRef, useState } from "react";
import type { ApiProvider, InferenceConfig, ModelList } from "../../shared/inference";
import type { SetupState } from "../../shared/setup";
import { applyUpdate, CheckPanel, startRun } from "./inference-check";
import type { CheckRun } from "./inference-check";
import { inferenceSummary, PROVIDERS, SAMPLE_TAIL } from "./preflight";
import type { SetupSource } from "./setup-source.d";

type Kind = "api" | "local" | "rules";
const LIMITS = [5000, 10_000, 15_000, 30_000];

/** IPC rejections arrive wrapped; show only main's own message. */
export function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
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
  const limit = state.settings.inferenceTimeoutMs;
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
  const [available, setAvailable] = useState<ModelList>();
  const [key, setKey] = useState("");
  const [check, setCheck] = useState<CheckRun>();
  const [error, setError] = useState<string>();
  const checkRef = useRef<CheckRun>(undefined);
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
  const running = check !== undefined && !check.result && !check.error;

  useEffect(
    () => () => {
      const current = checkRef.current;
      // Leaving the step invalidates its result even if cancellation arrives too late.
      checkRef.current = undefined;
      if (current && !current.result && !current.error) void source.cancel(current.id);
    },
    [source],
  );

  // Ask the endpoint what it offers as the user types, so a missing model shows early.
  useEffect(() => {
    if (kind !== "local") return;
    let live = true;
    const timer = window.setTimeout(() => {
      source.models(endpoint.trim()).then(
        (list) => {
          if (live) setAvailable(list);
        },
        (caught: unknown) => {
          if (live) setAvailable({ ok: false, failure: "failed", message: message(caught) });
        },
      );
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [kind, endpoint, source]);

  /** Any edit makes a finished check stale and stops one in progress. */
  const reset = () => {
    const current = checkRef.current;
    if (current && !current.result && !current.error) void source.cancel(current.id);
    checkRef.current = undefined;
    setCheck(undefined);
    setError(undefined);
  };
  const fail = (caught: unknown) => {
    setError(message(caught));
  };
  const choose = (next: Kind) => {
    reset();
    setKind(next);
    if (next === "rules") source.save({ inference: { kind: "rules" } }).then(onState, fail);
  };
  const isCurrent = (id: string) => checkRef.current?.id === id;
  const update = (id: string, change: (run: CheckRun) => CheckRun) => {
    const current = checkRef.current;
    if (current?.id !== id) return;
    checkRef.current = change(current);
    setCheck(checkRef.current);
  };
  const run = async () => {
    if (!draft) return;
    reset();
    const id = crypto.randomUUID();
    checkRef.current = startRun(id, limit, performance.now());
    setCheck(checkRef.current);
    try {
      const result = await source.check(id, draft, limit, (next) => {
        update(id, (current) => applyUpdate(current, next));
      });
      update(id, (current) => ({ ...current, result }));
      // Only a check that's still the current one may save its source.
      if (result.ok && isCurrent(id)) onState(await source.save({ inference: draft }));
    } catch (caught) {
      update(id, (current) => ({ ...current, error: message(caught) }));
    }
  };
  const saveKey = async () => {
    try {
      onState(await source.setKey(provider, key));
      setKey("");
      reset();
    } catch (caught) {
      fail(caught);
    }
  };
  const removeKey = async () => {
    try {
      onState(await source.removeKey(provider));
      reset();
    } catch (caught) {
      fail(caught);
    }
  };
  const limitField = (
    <label>
      Time limit
      <select
        value={limit}
        onChange={(event) => {
          reset();
          source.save({ inferenceTimeoutMs: Number(event.target.value) }).then(onState, fail);
        }}
      >
        {LIMITS.map((value) => (
          <option key={value} value={value}>
            {value / 1000} seconds
          </option>
        ))}
      </select>
    </label>
  );

  return (
    // Wide windows: choices on the left, the live check beside them.
    <div className="evaluator-layout" data-split={kind !== "rules"}>
      <div className="evaluator-main">
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
                      reset();
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
                      reset();
                    }}
                  />
                </label>
                {limitField}
              </div>
              {/* To use a different key, remove this one; the field to paste appears. */}
              {hasKey ? (
                <p className="preflight-key">
                  A key is saved in your system keychain.{" "}
                  <button type="button" className="link" onClick={() => void removeKey()}>
                    Remove key
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
                Stored in your system keychain. Foom never writes it in plain text or shows it
                again.
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
                      reset();
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
                    list="local-models"
                    onChange={(event) => {
                      setLocalModel(event.target.value);
                      reset();
                    }}
                  />
                  <datalist id="local-models">
                    {available?.ok &&
                      available.models.map((model) => <option key={model} value={model} />)}
                  </datalist>
                </label>
                {limitField}
              </div>
              {available && (
                <p className="preflight-server" data-tone={available.ok ? "ok" : "error"}>
                  {available.ok
                    ? `${available.server ?? "OpenAI-compatible server"} · ${String(available.models.length)} ${available.models.length === 1 ? "model" : "models"}${
                        localModel.trim() && !available.models.includes(localModel.trim())
                          ? ` · ${localModel.trim()} isn't one of them`
                          : ""
                      }`
                    : available.message}
                </p>
              )}
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

        {error && (
          <p className="preflight-result" data-tone="error" role="alert">
            {error}
          </p>
        )}
        <p className="preflight-in-use">
          <b>In use:</b> {inferenceSummary(saved)}
        </p>
        <p className="preflight-privacy">
          Foom sends the last 40 lines of a terminal that has gone quiet, with likely secrets
          redacted. It never sends files, diffs, or your keystrokes.
        </p>
      </div>
      {kind !== "rules" && (
        <section className="preflight-test" aria-label="Sample check">
          <div className="preflight-test-head">
            <h3>Try it on a sample</h3>
            <button
              type="button"
              disabled={!draft || running || (kind === "api" && !hasKey)}
              onClick={() => void run()}
            >
              Run check
            </button>
          </div>
          <pre className="preflight-tail">{SAMPLE_TAIL}</pre>
          {check ? (
            <CheckPanel
              run={check}
              onCancel={() => {
                void source.cancel(check.id);
              }}
            />
          ) : (
            <p className="preflight-result" role="status">
              {kind === "api" && !hasKey
                ? "Save a key, then run the check."
                : inUse
                  ? "In use. Run the check again any time."
                  : "Not run yet. Foom uses a source only after it passes."}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
