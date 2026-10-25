# Agent Verification

Historical v2 design questions from #423. The Copilot rows below describe the
1.0.95 draft; they are superseded by the [1.0.103 hand measurements](../agents.md#github-copilot-cli-410)
and [shipped manifest](../../src/shared/bundled-agents/copilot.json) from #410.
Cross-platform real CLI verification remains outstanding.

## Open questions and shipping gates

| Question | Evidence / next verification; no implied support |
| --- | --- |
| Copilot hooks through --plugin-dir | 1.0.95 top-level help proves local directory loading only. It does not document plugin.json/hooks.json layout, event names, stdin/argv, permissions or decisions. Draft hookVerified is false; its plugin.json/hooks.json and PascalCase stdin mapping are hypotheses, not evidence. Verify official contract and isolated human lifecycle probe before adding templates; never infer Claude-compatible hooks |
| Copilot MCP auth | Help proves session-additive JSON/@file and --allow-tool server syntax, not HTTP config layout or ${FOOM_CONTROL_TOKEN} expansion. Draft MCP file is a proposed shape held behind false mcpVerified. Verify environment-only bearer transport; never put token in file/argv or use --mcp-github-auth to forward account credentials |
| COPILOT_ALLOW_ALL values | Help refers to an environment help topic which this task did not run. Truthy values/exact true scope unverified; draft discloses every nonempty value. Replace only with measured documented predicate after review |
| Copilot screens | Read-only Herdr reference at main checkout inspiration/herdr/src/detect/manifests/github-copilot.toml 2026.08.29.1, also distribution copy. 13 draft rules are translations, not captures. Original whole_recent becomes bottom 40; background regex becomes bounded conjunction. No Herdr idle rule exists: idle/working/blocked real captures required for #410; unmatched stays neutral |
| Copilot resume/new UUID | Help advertises -r/--resume ID/name/prefix and --session-id sets UUID or resumes. Draft deliberately accepts full validated IDs only. Verify UUID equality and unknown-ID behavior by a human; restoreControl false until verified |
| Copilot --no-alt-screen | Not advertised in captured help. No inline fact/display flag; do not infer --screen-reader is equivalent |
| Cross-platform agent contracts | Existing measurements in agents.md are Linux only; native transport CI is not real CLI trust/timing proof. No new Claude/Codex/agy session or model call was run for this spec |
| Stable observer definitions during conversion | Preserve exact current Codex POSIX v1 / Windows v2 command spelling and timeout. The draft versions explicitly preserve POSIX 1 / Windows 2; implementation must preserve platform command serialization and filenames. New behavior/path requires review |
| Antigravity status safety | CLI list omits needed metadata. Generic fixed read-only metadata is necessary; parser must bound config structure and never surface other fields. Keep unknown installation unavailable and never overwrite; no arbitrary home reader |
| Antigravity compatibility | Current code permits installed observer versions >=2 and outdated <2. Require compatibility tests for old Stop/ordering behavior before assuming every recognized integer version is launchable |
| JSON templates and trust surface | Implement parsing/command-slot validation for arbitrary JSON/TOML containers without an agent-specific parser. Unknown executable extension points must reject; a template that cannot be proven observer-only is invalid, not a privileged built-in escape hatch |

Recorded help-only probe and its limits: [#423](https://github.com/scott-r-lindsey/foom/issues/423).
