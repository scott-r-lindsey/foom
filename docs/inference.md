# Model evaluator

Issue #15 supplies main-process services, like the rules evaluator in #14. It does
not start background inference or expose a new renderer capability. Preflight
(#17) owns source selection, key entry and Run check, and `Setup` builds the app's
evaluator from the saved source. Main should own one `ModelEvaluator` so its concurrency limit covers all
terminals, and discard stale results when output resumes, a terminal exits, or the
source changes.

Create an `InferenceKeys(userData)` after Electron is ready. `set(provider, key)`
stores a key; `get(provider)` is a main-only capability used by the transport;
`remove(provider)` deletes it. Never return `get` through IPC. If encryption is
unavailable (including Linux's `basic_text` fallback), offer local or rules-only
inference. New setup IPC must validate the sender and payload before saving keys.

`createInferenceSource(config, provider => keys.get(provider))` validates and copies
configuration. Supported configurations are:

```json
{"kind":"rules"}
{"kind":"anthropic","model":"claude-haiku-4-5"}
{"kind":"openai","model":"gpt-4.1-mini"}
{"kind":"google","model":"gemini-2.5-flash"}
{"kind":"local","model":"your-installed-model","endpoint":"http://127.0.0.1:11434/v1"}
```

Model names are explicit, not silently upgraded defaults. These are configuration
examples, not account-availability promises. Local endpoints include their API
base path and must use a loopback IP literal. Cloud API keys are never forwarded to
local endpoints. Cloud origins cannot be overridden and redirects are disabled.
Requests use [Anthropic Messages](https://platform.claude.com/docs/en/api/messages),
[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
or [Google generateContent](https://ai.google.dev/api), without tools or files.
Key protection follows [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

Pass the source to `new ModelEvaluator(source)`. `evaluate(input)` applies rules
first and invokes the model only for `rules:ambiguous`; all failures return the
original rules verdict. Pass `input => evaluator.evaluate(input)` as the second
argument to `VerdictLog` to persist these verdicts and their feedback using the
existing log. `runCheck()` bypasses rules to test the selected model with
a synthetic prose question, returning a verdict, status, and measured elapsed
milliseconds. Both entry points redact input, limit it to 40 physical lines, use the
configured deadline (five seconds by default), and share two slots.

Preflight's Run check uses `probeInference` from `src/main/evaluator/inference-probe.ts` instead, so
it can report each stage live and name failures precisely; see the evaluator section
of [architecture](architecture.md#evaluator-pipeline). It sends the same prompt and
parameters as classification, with streaming on. Setup must show its result before
accepting the source. A timeout or a reply that isn't the requested JSON is not a
successful check.
Unlabelled secrets can evade heuristic redaction. Response validation constrains
output shape, not classification accuracy or resistance to every prompt injection.

Claude and Codex CLI configurations are rejected with an actionable explanation.
The #11 probes establish one-shot invocation but do not prove that every avenue to
files, repository instructions, hooks, skills, MCP, and other external integrations
is disabled. No CLI is spawned, no user configuration is edited, and no broad
sandbox permission is substituted for tail-only isolation. Antigravity remains
unavailable. A future verified CLI adapter must pin a small model (for example
Claude Haiku 4.5), probe supported flags/version, enforce isolation independently of
the prompt, and pass these same deadline, concurrency, and setup checks.

## Fixture comparison

Normal unit tests and CI make no model calls. To benchmark a model you have
explicitly configured, use Node 24 and run:

```sh
FOOM_INFERENCE_CONFIG='{"kind":"local","model":"your-installed-model","endpoint":"http://127.0.0.1:11434/v1"}' npm run test:inference:live
```

For a cloud provider, supply the matching configuration and inject
`FOOM_INFERENCE_KEY` into the process environment from your secret manager (do not
put a literal key in command history). This developer-only harness keeps that key
in memory; application key entry must use `InferenceKeys`. The harness runs the
sample check, then the sanitized #14 fixtures sequentially through the actual
model source, reporting rule/model accuracy, transport status, and latency. It
never prints prompts, keys, or provider errors. The prose-question fixture expects
`needs_input` for the model comparison while retaining #14's conservative rules
baseline. Accuracy is reported rather than asserted; transport failures fail the
run. Without `FOOM_INFERENCE_CONFIG`, this test is skipped.
