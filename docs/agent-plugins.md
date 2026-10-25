# Agent plugin format v2

Version 2 supports discovery, launch, private MCP/hook files, prompts, scoped Foom tool grants, argument/environment bypass disclosure, resume, local attention, hook mapping/health, and setup status/actions/staging. Bundled and config manifests use the same engine; parsing alone grants no capability. There are no executable modules, privileged manifest capability names, agent-ID switches or automatic downloads.

Start with the [file map](map.md) and read the rules for the area you are changing. Decided rules live in the linked area and behavior documents; protocol details live in the contract documents. Changes to established decisions require their own PR and matching docs.

## Forge kind (#520 / #521)

See [Forge kind (#520 / #521)](contracts/forge-status.md#forge-kind-520--521).

## Behavior inventory and representation

See [Behavior inventory and representation](contracts/agent-behaviors.md#behavior-inventory-and-representation).

## Evidence baseline

Historical record: [#423](https://github.com/scott-r-lindsey/foom/issues/423).

## Closed schema and limits

See [Closed schema and limits](contracts/agent-schema.md#closed-schema-and-limits).

## Trust model

See [Trust model](contracts/agent-trust.md#trust-model).

## Code versus data

See [Code versus data](contracts/agent-trust.md#code-versus-data).

## Migration and acceptance for later implementation

See [Migration and acceptance for later implementation](contracts/agent-compatibility.md#migration-and-acceptance-for-later-implementation).

## Bundled manifest delivery (#434)

See [Bundled manifest delivery (#434)](contracts/agent-compatibility.md#bundled-manifest-delivery-434).

## Complete manifests

The shipped, build-locked JSON is authoritative: [Claude Code](../src/shared/bundled-agents/claude.json), [Codex](../src/shared/bundled-agents/codex.json), [Antigravity](../src/shared/bundled-agents/agy.json), [Pi](../src/shared/bundled-agents/pi.json). Config copies must change ID and name; see [customization](contracts/agent-trust.md#customizing-a-built-in-agent). The [Copilot draft](research/copilot-manifest.md) is unverified and blocked by [#410](https://github.com/scott-r-lindsey/foom/issues/410); it grants no support.

## Open questions and shipping gates

See [Open questions and shipping gates](research/agent-verification.md#open-questions-and-shipping-gates).

<a id="launch-substitutions-and-hook-files"></a>
See [area rules](contracts/agent-launch.md#launch-substitutions-and-hook-files).

<a id="argument-and-environment-matchers"></a>
See [area rules](contracts/agent-launch.md#argument-and-environment-matchers).

<a id="payload-mapping-execution-and-health"></a>
See [area rules](contracts/agent-hooks.md#payload-mapping-execution-and-health).

<a id="detection-and-resume-paste"></a>
See [area rules](contracts/agent-detection.md#detection-and-resume-paste).

<a id="setup-status-and-fixed-actions"></a>
See [area rules](contracts/agent-setup.md#setup-status-and-fixed-actions).

<a id="customizing-a-built-in-agent"></a>
See [area rules](contracts/agent-trust.md#customizing-a-built-in-agent).

<a id="claude-code"></a>
See [area rules](agent-plugins.md#complete-manifests).

<a id="codex"></a>
See [area rules](agent-plugins.md#complete-manifests).

<a id="antigravity"></a>
See [area rules](agent-plugins.md#complete-manifests).

<a id="github-copilot-cli-1095"></a>
See [area rules](#github-copilot-cli-1095).

<a id="offline-capability-report"></a>
See [area rules](contracts/agent-report.md#offline-capability-report).

## Unverified schema fixture

This disabled draft is retained here because `tests/unit/main/config/layout.test.ts` validates it directly. It is not a supported agent or required area reading. [Verification gates](research/agent-verification.md) and [#410](https://github.com/scott-r-lindsey/foom/issues/410) still apply.

### GitHub Copilot CLI 1.0.95

```json
{
  "kind": "agent",
  "version": 2,
  "id": "copilot",
  "name": "GitHub Copilot",
  "badge": "CP",
  "executables": ["copilot"],
  "discovery": {
    "version": {
      "prefix": "GitHub Copilot CLI ",
      "suffixes": [".", ".\nRun 'copilot update' to check for updates."],
      "minimum": [1, 0, 95]
    },
    "facts": [
      {"id": "promptSupport", "minimum": [1, 0, 95], "helpTokens": ["--interactive"]},
      {"id": "mcpSurface", "minimum": [1, 0, 95], "helpTokens": ["--additional-mcp-config", "--allow-tool"]},
      {"id": "pluginSurface", "minimum": [1, 0, 95], "helpTokens": ["--plugin-dir"]},
      {
        "id": "mcpVerified",
        "enabled": false,
        "when": {"all": [{"field": "mcpSurface", "op": "eq", "value": true}]}
      },
      {
        "id": "hookVerified",
        "enabled": false,
        "when": {"all": [{"field": "pluginSurface", "op": "eq", "value": true}]}
      }
    ]
  },
  "launch": {
    "order": ["resume", "defaults", "arguments", "display", "guidance", "mcp", "hooks", "tools", "prompt"],
    "arguments": {"arguments": []},
    "prompt": {"arguments": ["--interactive", "{prompt}"], "requires": "promptSupport"},
    "resume": {"arguments": ["--resume", "{conversationId}"]},
    "mcp": {
      "arguments": ["--additional-mcp-config", "@{file:mcp.json}"],
      "when": {
        "all": [{"field": "control", "op": "eq", "value": true}, {"field": "mcpVerified", "op": "eq", "value": true}]
      }
    },
    "toolPermissions": {
      "names": ["open_preview", "list_previews", "close_preview"],
      "format": "server-parentheses",
      "arguments": ["--allow-tool", "{tool}"]
    }
  },
  "files": [
    {
      "name": "mcp.json",
      "scope": "launch",
      "format": "json",
      "content": "{\"mcpServers\":{{mcpName:json}:{\"type\":\"http\",\"url\":{mcpUrl:json},\"headers\":{\"Authorization\":\"Bearer ${FOOM_CONTROL_TOKEN}\"}}}}",
      "when": {
        "all": [{"field": "control", "op": "eq", "value": true}, {"field": "mcpVerified", "op": "eq", "value": true}]
      }
    },
    {
      "name": "plugin.json",
      "scope": "launch",
      "format": "json",
      "content": "{\"name\":\"foom-observer\",\"version\":\"1.0.0\"}",
      "when": {
        "all": [
          {"field": "hooksEnabled", "op": "eq", "value": true},
          {"field": "hookVerified", "op": "eq", "value": true}
        ]
      }
    },
    {
      "name": "hooks.json",
      "scope": "launch",
      "format": "json",
      "content": "{\"hooks\":{\"SessionStart\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}],\"UserPromptSubmit\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}],\"PreToolUse\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}],\"PermissionRequest\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}],\"PostToolUse\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}],\"Stop\":[{\"type\":\"command\",\"command\":{observerCommand:lifecycle:json},\"timeout\":3}]}}",
      "when": {
        "all": [
          {"field": "hooksEnabled", "op": "eq", "value": true},
          {"field": "hookVerified", "op": "eq", "value": true}
        ]
      }
    }
  ],
  "reservedArguments": [
    {"flag": "--resume", "forms": ["exact", "equals"]},
    {"flag": "--continue", "forms": ["exact", "equals"]},
    {"flag": "--session-id", "forms": ["exact", "equals"]},
    {"flag": "--connect", "forms": ["exact", "equals"]},
    {"prefix": "-r"}
  ],
  "bypassArguments": [
    {"flag": "--yolo", "forms": ["exact", "equals"]},
    {"flag": "--allow-all", "forms": ["exact", "equals"]},
    {"flag": "--allow-all-tools", "forms": ["exact", "equals"]},
    {"flag": "--allow-all-paths", "forms": ["exact", "equals"]},
    {"flag": "--allow-all-urls", "forms": ["exact", "equals"]}
  ],
  "bypassEnvironment": [{"name": "COPILOT_ALLOW_ALL", "match": "present-nonempty"}],
  "conversation": {
    "resumePin": "requested-on-paste",
    "restoreControl": false,
    "newId": {"format": "uuid", "arguments": ["--session-id", "{newId}"]}
  },
  "resumePaste": [{"command": "copilot", "selector": "--resume"}, {"command": "copilot", "selector": "-r"}],
  "attention": {
    "minimumEngineVersion": 1,
    "rules": [
      {
        "id": "selection-0-0",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc to cancel", "enter to select"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-0-1",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc to cancel", "enter to confirm"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-0-2",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc to cancel", "enter to submit"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-0-3",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc to cancel", "enter accept"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-1-0",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc cancel", "enter to select"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-1-1",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc cancel", "enter to confirm"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-1-2",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc cancel", "enter to submit"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "selection-1-3",
        "state": "blocked",
        "priority": 300,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc cancel", "enter accept"]},
        "reason": "Selection requested",
        "comment": "Herdr selection_blocker translated as conjunction; unmeasured Copilot screen."
      },
      {
        "id": "background-agents",
        "state": "working",
        "priority": 110,
        "region": "bottom",
        "lines": 6,
        "match": {"contains": ["◎", "Waiting for background agents"]},
        "reason": "Waiting for background agents",
        "comment": "Bounded approximation of Herdr line regex; requires captures before shipping."
      },
      {
        "id": "working-cancel-0",
        "state": "working",
        "priority": 100,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc to cancel"]},
        "reason": "Agent is working",
        "comment": "Herdr cancel hint; selection blockers outrank it; unmeasured."
      },
      {
        "id": "working-cancel-1",
        "state": "working",
        "priority": 100,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc cancel"]},
        "reason": "Agent is working",
        "comment": "Herdr cancel hint; selection blockers outrank it; unmeasured."
      },
      {
        "id": "working-cancel-2",
        "state": "working",
        "priority": 100,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc again to cancel"]},
        "reason": "Agent is working",
        "comment": "Herdr cancel hint; selection blockers outrank it; unmeasured."
      },
      {
        "id": "working-cancel-3",
        "state": "working",
        "priority": 100,
        "region": "bottom",
        "lines": 40,
        "match": {"contains": ["esc interrupt"]},
        "reason": "Agent is working",
        "comment": "Herdr cancel hint; selection blockers outrank it; unmeasured."
      }
    ],
    "provenance": {
      "source": "inspiration/herdr/src/detect/manifests/github-copilot.toml (2026.08.29.1)",
      "license": "Apache-2.0; Herdr contributors",
      "modified": "Draft bounded translation: 8 selection conjunctions, 1 background approximation, 4 cancel hints; no idle rule or real screen measurement."
    }
  },
  "execution": {"completion": "observed", "completionChannels": ["lifecycle"]},
  "hooks": {
    "channels": [
      {
        "id": "lifecycle",
        "when": {
          "all": [
            {"field": "hooksEnabled", "op": "eq", "value": true},
            {"field": "hookVerified", "op": "eq", "value": true}
          ]
        },
        "observer": {
          "transport": "stdin",
          "placement": "launch",
          "version": 1,
          "response": "silent",
          "delivery": "foreground",
          "timeoutMs": 3000
        },
        "arguments": ["--plugin-dir", "{hookDir}"],
        "mapping": {
          "session": {"source": "payload", "path": ["session_id"]},
          "event": {"source": "payload", "path": ["hook_event_name"]},
          "cases": [
            {"id": "SessionStart", "event": "SessionStart", "action": "ready"},
            {"id": "UserPromptSubmit", "event": "UserPromptSubmit", "action": "working"},
            {"id": "PreToolUse", "event": "PreToolUse", "action": "working"},
            {"id": "PermissionRequest", "event": "PermissionRequest", "action": "needs_input"},
            {"id": "PostToolUse", "event": "PostToolUse", "action": "working"},
            {"id": "Stop", "event": "Stop", "action": "classify"}
          ]
        }
      }
    ]
  }
}
```

### Saved screen-rule regressions (#592)

See [saved screen-rule regressions](contracts/agent-report.md#saved-screen-rule-regressions-592).

### User-authored extensions: public hook protocol 1 (#635)

For an agent whose extension API runs code, use `"observer":{"transport":"external"}`
and `"arguments":[]` on a channel. Its `when`, payload mapping, requirements,
dedupe, attention and conversation tracking work exactly as for other channels.
External channels alone create no observer files, counters or launch arguments.
Observer placeholders cannot reference them. A separately selected
[fixed per-launch extension](contracts/agent-launch.md#fixed-extension-attachment-834)
can provide application-owned glue, as bundled Pi does. Otherwise the user installs
their own extension through their agent's extension mechanism. Neither path edits
global agent configuration.

The launch environment is the credential contract:

| Variable | Meaning |
| --- | --- |
| `FOOM_HOOK_PROTOCOL` | `1`; reject unsupported versions |
| `FOOM_HOOK_URL` | Literal `http://127.0.0.1:<port>/hooks` receiver |
| `FOOM_SESSION` | Random launch UUID (not the agent conversation ID) |
| `FOOM_TOKEN` | Launch-only 256-bit token, 64 lowercase hex digits |
| `FOOM_CHANNEL_<id>` | Channel ID, with hyphens replaced by underscores in the variable name |
| `FOOM_HOOK_CHANNELS` | JSON array of attached external channel IDs |

Call `foom hook EVENT [--channel ID]` with one UTF-8 JSON value on stdin, at
most 64 KiB. EVENT matches `[A-Za-z][A-Za-z0-9_-]{0,63}` and is sent in
`X-Foom-Event`; mappings may select that header or a payload event field.
One attached external channel is selected automatically; multiple channels require
`--channel`. The command never derives credentials, receiver or channel from the
payload, discovers another app, pairs, or uses control credentials. Without all
three URL/session/token variables it exits 0 immediately, silently, without reading
stdin or making a network call. All paths are silent. With credentials present,
exit 0 means accepted, 1 means receiver refusal/transport failure, and 2 means
invalid input/environment. Delivery has a three-second deadline and bypasses proxies.
Extensions should treat reporting as best effort and never gate an agent permission
decision on it.

Generic Node extension glue (adapt event names and payloads to your manifest):

```js
const { spawn } = require('node:child_process');
function report(event, conversationId) {
  if (process.env.FOOM_HOOK_PROTOCOL !== '1') return;
  const child = spawn('foom', ['hook', event], {
    env: process.env, stdio: ['pipe', 'ignore', 'ignore'], shell: false,
  });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ conversationId }));
}
```

The receiver authenticates `Authorization: <FOOM_TOKEN>` and
`X-Foom-Session: <FOOM_SESSION>`, with `X-Foom-Channel` identifying the attached
channel. It keeps the existing literal loopback/Host and no-Origin checks, 8 KiB
header and 64 KiB body limits, mapping validation, dedupe and shared first-event
conversation pin. Unknown events are inert; malformed or mismatched IDs fail.
`classify` only requests local evaluation, never directly declares Done.
Credentials are revoked on launch failure, exit/removal and shutdown. Stale,
foreign and mixed launch credentials fail authentication. Payload text grants no
capability and is discarded; never log, save or copy credentials into a manifest,
agent configuration, extension source or conversation transcript. Same-user code
inheriting the launch environment is within that launch's trust boundary.

## Per-launch environment (#636)

For CLIs that accept a configuration path through the environment, declare
`launch.environment` entries such as
`{"name":"AGENT_CONFIG","value":"{file:config/mcp.json}","when":{"all":[{"field":"control","op":"eq","value":true}]}}`.
Declare that launch file with matching conditions and select `launch.mcp` with
those conditions; its `arguments` may be empty for an environment-only attachment.
Up to eight entries may carry whole owned file paths or short fixed literals.
Names exclude runtime injection, command selectors (such as `EDITOR` and `PAGER`),
code-loading paths, resolver overrides, `TMPDIR`, proxy, credential and Foom
variables; values never expand the inherited environment. See the [complete rules and diagnostics](contracts/agent-launch.md#per-launch-manifest-environment-636).

## Probe hook and MCP verification (#593)

See [probe verification](contracts/agent-report.md#probe-hook-and-mcp-verification-593).
