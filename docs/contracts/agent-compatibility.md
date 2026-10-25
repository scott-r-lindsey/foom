# Agent Compatibility

## Migration and acceptance for later implementation

The v2 engine is implemented; older agent manifest formats are unsupported. The Copilot shipping gates below remain future work.

| Input/state | Required migration |
| --- | --- |
| Agent manifest versions | Only version 2 is accepted. Version 1 rejects the file whole with `Agent manifest version 1 is no longer supported; use version 2 (see README.md)`; any other version with `Agent manifest version must be 2 (see README.md)` |
| Bundled defaults/consents | Same IDs/enable switches/default argv/session IDs. Profile acknowledgements map to equivalent disclosure identity only if content/effect unchanged; otherwise ask again. Never import trust from agent stores |
| Codex health | Transfer only identical definition fingerprint; stable observer command/timeout must remain identical for unchanged observer. Changed generated definition invalidates Foom health and lets Codex request review |
| agy plugin | Recognize foomObserverVersion >=3 with the current staging fingerprint; legacy or mismatched definitions offer update, disabled needs enable; unknown foom refuses mutation |
| Config copy of a built-in | Copy with identity changed; full manifest, hand-made (#538 removed the Settings action). No loss of hooks/setup/resume/protections. Consent/observed health not copied; same ownership target serialized across copies |
| Dormant conversations | Missing/invalid provider preserves row/ID but grants no launch; new invocation rechecks the loaded provider and checkout |

Changes to the implemented engine must keep existing unit/Electron/native hook tests passing on
all three OSes, add a manifest-only fixture (no real agent CLI probes), and verify
invalid/changed-byte races, stable Codex definitions/fallback/deduplication, unknown
plugin ownership, setup cancellation, bypass environment redaction, protected argv
forms and prompt/tool merge. Extend offline validation without probing/approval.
Do not lower coverage or relax security to accommodate a template. Copilot shipping
requires human recorded screen captures and isolated hook/MCP measurements; help
alone is not that gate. Parser validation runs `pnpm run check`; tests never run real-agent sessions.

## Bundled manifest delivery (#434)

`src/shared/bundled-agents/` contains data-only JSON imported into the application
bundle by the normal build. `shared/bundled-agent-data.ts` lists these build inputs;
`main/agents/providers/bundled.ts` owns their expected IDs and SHA-256 locks over
`JSON.stringify(importedData)` UTF-8 bytes. Whitespace in the source JSON is not
part of this build lock; object/array order and all parsed values are. The loader
checks the digest, parses with the same strict v2 validator, verifies the expected
identity, and constructs the same immutable `v2Provider` used for config files.
A mismatch or invalid manifest fails startup before any discovery or launch;
there is no fallback to an old provider or a user approval prompt. This detects
an accidentally modified build input, not an attacker who can replace application
code and its lock together. No manifest path, origin, digest, code, include or
module can be nominated by JSON, agent output or renderer IPC.

Bundled manifest revisions travel only in reviewed application builds. A semantic
edit updates the JSON and its code-owned digest together; the digest identifies
that revision and the app version distributes it. Observer behavior changes must
also revise the declared observer ABI; stable definitions/health retain their
separate exact-definition rules. To convert another provider, add its complete
manifest to the build list, pin its ID/digest in the loader, replace its legacy
registration, remove its old policy branches, and add compatibility/failure tests.
The shared catalog reserves all existing built-in IDs throughout conversion;
config registration independently rejects collisions. Config copies change identity
and load as ordinary config plugins; bundled origin/consent is never
copied. Config files cannot claim `bundled` provenance.

Main assigns `origin: bundled` to loaded providers and `providerOrigin: bundled`
to new session records. Existing origin-less Claude rows remain valid with the
same IDs. No settings or profile consent is rewritten: enablement, hooks, defaults,
environment lists and argument-bypass acknowledgements keep the `claude` key.
Bundled argument bypass retains the existing Settings/config-change acknowledgement
flow; environment bypass still requires launch confirmation, and unattended child
bypass always fails. Conversions may reuse an acknowledgement only for an
identical disclosure/effect. They must explicitly preserve setup consent and health observations; bundled build trust never substitutes for those decisions.

Claude compatibility details:

- Resume/default/MCP/merged preview grants/hooks/prompt order and inline `--settings`
  JSON are preserved, including JSON member order. The draft's file attachment is
  valid schema but was corrected to inline JSON to preserve existing argv. The
  standalone file-based fixture remains coverage for the generic file interface.
- The generic observer uses its private `control/lifecycle/observer.sh` or `.ps1`
  canonical path instead of `claude.sh`/`.ps1` (including macOS `/private/var` and expanded Windows short paths), and adds a launch-bound channel header and
  bounded stdin read. Commands use the fixed platform serializer (the same normal-path spelling, with encoded Windows invocation for shell metacharacters);
  MCP JSON retains identical content in the common private launch directory; its temporary parent also changes. No credentials enter settings/argv. Windows still probes interpreter/policy
  before registration. These temporary observer bytes/paths change, with no
  permission decision, global configuration write or change to the 3-second timeout.
- Reduced hook diagnostics now use `plugin:claude:<case-id>` and carry generic
  channel/turn metadata. The restore fixture that directly posts hooks now supplies the launch-bound channel header, as the generated observer does. `idle_prompt` explicitly has `endsTurn:false`; Stop remains
  completion evidence and title-only interruptions remain neutral. Notification
  requirements use the v2 bounded nonempty string contract. Unknown notifications
  remain inert and malformed values fail closed.
- Reserved-argument errors retain agent/line context with generic wording. The
  v2 engine refuses a requested orchestrator restore without actual MCP attachment;
  normal restore already requires this capability. It also rejects malformed
  unbalanced tool rules as the shared grammar requires. Complete help-token matching also accepts tab separators; the captured Claude help still uses the same verified flags.

Antigravity compatibility details (#436):

- The same `agy` settings, defaults, conversation IDs and bypass acknowledgement remain in place. The profile-only legacy offer answer is copied into generic offer tracking; this grants no setup or hook trust. Setup now uses the shared trusted action dialog for install, update, enable and remove. Its status/actions are supplied by the manifest. Unknown ownership still refuses mutation. An explicit plugin preference object with a missing enabled leaf remains unavailable, encoded as an ordered metadata condition. The legacy setup IPC name forwards to these same checks and confirmations.
- `observer.protocol: "ordered-v2"` retains the fixed native ordered transport ABI (stdin, empty JSON first, detached delivery, sequence counter and one-second timeout). Versions 2 and 3 are accepted for compatibility. The bundled version is now 3: observer filenames and native script bytes stay unchanged, while commands use absolute CLI-owned installation paths regardless of the CLI's cwd (#467/#723). It uses `FOOM_HOOK_ORDER` and accepts a missing channel header only for that launch-bound single channel.
- Bundled ownership no longer declares `unfingerprintedVersion: 2`; recognized legacy versions offer Update. The optional field remains available to config manifests. Explicit fingerprint mismatches offer Update. All owned states offer Reinstall (confirmed uninstall then install) and Remove.
- agy 1.4.x status uses `plugin list --json` with a top-level array and enabled switches. A failed command falls back to the 1.3.x object or empty text. Bounded metadata remains required for ownership and observer version. Hooks point to the CLI-owned installed observers. Status compares the installed hook and observer bytes to the generated definition; missing, changed or redirected targets offer Update/Reinstall. Identical definitions installed by Dev, everyday, or disposable profiles have the same target and status.
- Sequenced completion reports rely on validated monotonic sequence deduplication rather than inferred execution-turn deduplication. A newer failure remains visible even if its working report was lost after an earlier completion. Unsequenced lifecycle/notify turn deduplication is unchanged.
- Reduced hook diagnostics use `plugin:agy:<case-id>` plus generic channel/turn metadata. Unknown events are inert (204), without pinning identity or emitting evidence, as for config plugins; malformed known events still fail closed. Reserved defaults and missing prompt-value errors now use generic wording. Tests assert these explained differences while retaining the lifecycle, privacy, ordering, resume and failure checks.

Codex compatibility details (#435):

- The same data engine emits resume → defaults → inline display → MCP → six
  lifecycle definitions → optional notify → prompt. MCP uses the same random
  server name and environment bearer reference; this conversion adds no preview
  tool pre-approval. The complete reservation and bypass matchers include quoted,
  attached-short and nested sandbox overrides.
- Bundled stable observers are build-generated installed assets, outside ASAR;
  config stable observers use private profile paths. This is main-owned build
  provenance, not a manifest privilege. Both use the same ABI generator and
  serializer. The installed `codex-v1.sh` / `codex-v2.ps1` path, trailing literal
  `codex`, six TOML definitions, member order and `timeout=3` are byte-identical
  to the previous provider on both platforms, including special-character paths.
  Independent pre-conversion serializer tests lock those bytes.
- Matching observations in the legacy profile `codex-hook-health.json` migrate
  to the shared private observer directory without rewriting the legacy file.
  The SHA-256 still covers the exact expanded six-definition argv. Bounded,
  identity-checked reads reject links, multiple links and unsafe ownership or
  permissions. Windows permits the old inherited current-user/SYSTEM/local
  Administrators ACL only at this read-only migration boundary; new records are
  protected current-user-only files. A corrupt or stale private record never
  falls back to old trusted data. Changed definitions are outdated; missing or
  malformed data grants no trust. Newer launches alone own writes.
  The generic observed-health engine preserves startup metadata, review text,
  per-turn prompt/Stop observation, late-turn fallback and completion deduplication.
- Bundled Codex attaches notify per launch without warning or confirmation (#633).
  Stored `codexNotifierAcknowledged` values are tolerated and ignored. The generic
  v2 channel `disclosure` mechanism remains available to user manifests.
  Config copies never inherit bundled health. Enablement, defaults, environment scopes,
  argument bypass acknowledgement and dormant conversation IDs keep the same keys.
- Private notify paths now use the generic launch directory. Generated observers
  add a launch-bound channel header and bound input; their timeout, silent
  observe-only behavior and environment-only credentials are unchanged. Reduced
  diagnostics use `plugin:codex:<case-id>` with channel/turn metadata. Tests that
  post directly now identify their channel. Observed-health fields use generic names; notifier acknowledgement plumbing is removed.
  The shipped manifest keeps the existing inline `/hooks in Codex` hint; the
  fixture retains the optional instruction action to exercise that generic surface.
  Reserved-argument errors retain the original agent and argument line with
  engine-owned wording.


OpenCode delivery (#824): the bundled ID supersedes a same-ID config manifest
without editing it. A build-owned former-config ID list preserves existing config
conversation rows, but automatic restart and role restore skip those rows until an
explicit bundled Resume replaces their origin. All ordinary ID-keyed preferences
retain the existing recovery and bypass-disclosure rules. See
[provider collision behavior](../areas/providers.md#bundled-opencode-824).
