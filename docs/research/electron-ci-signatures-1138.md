# Remaining Electron signatures from #1056 (#1138)

This investigation uses the fixed [60-run census](https://github.com/scott-r-lindsey/foom/issues/1056#issuecomment-6711208172) as historical evidence and a separate bounded extension. Counts from different samples are not added together. No observation here establishes runner load or an insufficient deadline.

## Bounded extension

Downloaded every available `electron-results-*` artifact for these six runs on 2026-11-10, including duplicate names uploaded by later attempts. Numeric artifact IDs remain the identity; successful reruns do not erase failures. The first four runs reproduce the previous 67-artifact supplement. The two additional runs extend it through the newly reported main failure.

| Run | Latest available attempt / outcome at download | Electron artifacts |
| --- | --- | ---: |
| [42545513976](https://github.com/scott-r-lindsey/foom/actions/runs/42545513976) | 2 / success | 17 |
| [42551694817](https://github.com/scott-r-lindsey/foom/actions/runs/42551694817) | 3 / success | 17 |
| [42551903310](https://github.com/scott-r-lindsey/foom/actions/runs/42551903310) | 2 / success | 17 |
| [42552709991](https://github.com/scott-r-lindsey/foom/actions/runs/42552709991) | 2 / success | 16 |
| [42589044729](https://github.com/scott-r-lindsey/foom/actions/runs/42589044729) | 3 / success | 19 |
| [42761463525](https://github.com/scott-r-lindsey/foom/actions/runs/42761463525) | 2 / cancelled | 16 |

The 102 artifacts were uploaded between 2026-11-09 01:35:09 and 2026-11-10 08:22:12 UTC. Three contain incomplete XML: **13663065813**, **13666267710** (42589044729, the macOS shard step-budget signature tracked in #1142), and **13746706006** (42761463525, cancelled replay rerun). These cannot supply a completed-case result. The latest successful third attempt of 42589044729 supersedes the earlier handback's whole-run failure status; its two original incomplete reports remain in the sample.

| In-scope named case | Failed / executed JUnit observations | Total duration range, seconds |
| --- | ---: | ---: |
| Footer zoom/master volume | 0 / 18 | 2.476–9.984 |
| Config probe CLI | 0 / 18 | 9.526–62.783 |
| Running-shell worktree deletion | 0 / 21 | 3.352–20.614 |
| SSH-loss replay | 2 / 14 | 9.252–55.139 |

Executed observations exclude explicit platform skips; case durations are not operation deadlines or phase measurements. No failure in this bounded sample proves recovery of an older signature. Installer attach is outside these Electron JUnit artifacts and has no inferred frequency here.

All failed named observations in the extension, preserving original artifact IDs:

| Run / original artifact | Failure | JUnit seconds | Disposition |
| --- | --- | ---: | --- |
| 42545513976 / **13643143997** | Windows preview drag: missing drop preview | 38.769 | #1141 fixes restore/drag geometry ordering |
| 42545513976 / **13643709113** | macOS WebGL teardown: quit confirmation | 30.600 | #1134 |
| 42551694817 / **13645683548** | Linux preview navigation: textarea inactive | 12.750 | #1133 |
| 42551694817 / **13648500943** | Linux unanswered-request elapsed-time assertion, attempt 2 | 32.165 | #1129; outside #1138 |
| 42551903310 / **13645888362** | Windows CIM snapshot killed with empty output | 30.276 | #1136 |
| 42551903310 / **13646043326** | Windows partial prompt before Close scenario | 37.033 | #1137 |
| 42552709991 / **13646935699** | macOS restored protected layout: 0 versus 65 tiles | 17.523 | #1135; fixed on merged main by [#1169](https://github.com/scott-r-lindsey/foom/pull/1169) |
| 42589044729 / **13661092942** | Windows partial prompt before Close scenario | 37.775 | #1137, same setup signature |
| 42589044729 / **13661746896** | macOS replay: tail rejected before deliberate loss | 11.364 | Needs the original connection-retirement ordering; no wire trace in this artifact |
| 42761463525 / **13738033952** | macOS replay: two SSH owners before deliberate loss | 9.837 | Acknowledgement burst reproduced; coalesced in this PR |

## Historical ranking and disposition

The fixed 60-run sample ranks sound (3 failures, Linux/macOS, **11.75–13.23 s**), config probe (2, macOS, **8.08–13.94 s**), shell-exit deletion (1, macOS, **14.06 s**), and hdiutil attach (1 job, outside JUnit). Group cleanup moved to [#1146](https://github.com/scott-r-lindsey/foom/issues/1146), with its fix in [#1147](https://github.com/scott-r-lindsey/foom/pull/1147). Remote quit is separately fixed by [#1103](https://github.com/scott-r-lindsey/foom/pull/1103).

### Footer sound

[Original job](https://github.com/scott-r-lindsey/foom/actions/runs/42395183771/job/128470957731), first-attempt artifact **13584640276**, reaches the expected slider value but reports zero playback starts. It does not record keydown/input/keyup, the settings used by the sample callback, sink identity, or asynchronous decode cancellation. [#918](https://github.com/scott-r-lindsey/foom/pull/918) already retains pending unmuted slider settings before a delayed parent render; that fix predates this failure and cannot be claimed as its resolution. Current unit regressions cover delayed parent rerender for pointer and keyboard release. The 18 passing extension executions rule out an unconditional failure on those revisions, but not an intermittent sample/cancellation ordering defect. Needed: a natural failed native-input trace with callback settings, sink/decode generation and playback-start order. No speculative sound change is included.

### Config probe selector

[Original job](https://github.com/scott-r-lindsey/foom/actions/runs/42365888837/job/128383800010), first-attempt artifact **13573054992**, supplies the cause directly: `.config-dock .board-row` filtered by `Probe` resolves to two elements. The parent config row contains `Probe waiting`; the actual probe contains its `Probe` label. The original assertion can run before or after that parent status appears. This is a strict-locator ambiguity, not evidence that the probe is missing or late. This PR selects the probe's actual workspace terminal ID and deliberately rechecks its visibility after the parent's reminder appears. The visibility, disclosure, driver, attention, stop, capture and cleanup assertions remain. A controlled local run first settled the parent reminder while retaining the old selector, then reproduced the same two-row strict-mode failure; fixture cleanup completed normally.

### Shell-exit deletion

[Original job](https://github.com/scott-r-lindsey/foom/actions/runs/42382601259/job/128433256327), first-attempt artifact **13579303050**, times out on the workspace shell's `exited` flag after requesting `exit`. Native focus and a painted textarea do not prove login or attachment readiness. The test still sends input through the validated bridge and observes workspace exit; the report contains neither the input-admission decision nor the PTY bytes/native-exit event. The 21 passing extension observations rule out a persistent deletion failure in those executions. Needed: shell prompt and editable/attachment state before input, bridge acceptance, parsed tail, native exit, then workspace publication on the failing run. No product deletion change is justified by this predicate alone.

### Installer attach

[Original job](https://github.com/scott-r-lindsey/foom/actions/runs/42382601259/job/128435156309) completes packaged Electron smoke, then `hdiutil attach -readonly -nobrowse -mountpoint …` fails with `Resource temporarily unavailable`. The preceding image creation succeeds. The existing [#887](https://github.com/scott-r-lindsey/foom/pull/887) create-command handling does not address this distinct attach operation. No disk-image service, mount/device state, or attach ordering trace is recorded, so attributing it to load, a corrupt image, or lingering mounts would be speculation. Needed: bounded hdiutil image/attach and mount-state diagnostics on failure. No retry or deadline change is included.

### SSH-loss replay

The new main failure has an ownership trace: the first SSH opens the live PTY, handles ordinary input and starts the bulk-output command; its acknowledgement total advances by 390 between output observations, then it exits before the deliberate-loss marker. The next SSH opens the same live ID and renders the 408,669-character replay. The daemon's 256-operation backlog rejects a 390-frame burst before its asynchronous dispatch chain can drain. A deterministic real-socket daemon regression reproduces that rejection and accepts the equivalent summed acknowledgement. The client regression holds the first reply while 390 acknowledgements arrive and verifies exact summed counts, token replacement, invalid-count handling, detach and failed-stream discard.

The fix retains one outstanding remote acknowledgement and one accumulated count for the next reply. It keeps local utility-host behavior and the daemon's backlog limit. The existing Electron scenario still rejects unsolicited reconnects, checks pinned uploaded bytes, performs a deliberate SSH loss, and verifies the same shell PID, clipboard replay suppression, palette and subsequent live input. See [fixture details](../electron-fixtures.md#remote-acknowledgement-bursts-1138).

Artifact **13661746896** predates the wire observer. Its tail error is consistent with connection retirement, but does not prove the same cause. The older fixed-census replay failure (**14.59 s**) likewise lacks the ordering needed for attribution. Neither is relabelled as the new cause merely because its test name matches.

## Original uncounted notes

These remain uncounted; test-name matches in later reports do not establish matching assertion signatures.

| Original note | Current-main reconciliation / exact missing evidence |
| --- | --- |
| Missing Delete worktree / Click again to remove | Both assertions still exist in `workspace-repositories.test.js`. [#1055](https://github.com/scott-r-lindsey/foom/pull/1055) fixes a documented resize/menu-dismissal ordering defect; without the original event trace it is not proof for every missing-menu note. Need native resize, menu-open/dismiss and click-hit-target order for any recurrence. |
| Startup execution-context destruction (`nativeState`, `boardPage`) | The harness now awaits `boardStartup.waitForDocument()` before page discovery, with document/navigation regressions and failure diagnostics. The document-readiness fixture work in [#759](https://github.com/scott-r-lindsey/foom/pull/759) and later startup/trace-registration changes are retained; a matching failed run still needs target creation, document/navigation, nativeState evaluation and close/crash order. No failure in this extension is assigned to this note. |
| INPUT_READY setup | The marker is still asserted after native command entry in the terminal scenarios. [#986](https://github.com/scott-r-lindsey/foom/pull/986) exposes attachment input readiness, while #1137 investigates a separate partial-prompt precondition. Neither proves which older INPUT_READY failure occurred. Need the exact case/artifact plus prompt, input-admission and fixture-exec order. |
| Fullscreen command entry | The Settings fullscreen fixture remains live and uses native command input. Completed fullscreen cases in the extension passed; this does not identify the older uncounted failure. Need the original case/artifact and shell/attachment/input/output order before NORMAL_VIEW_READY. |
| Login-shell probing | Login-shell isolation is covered by native fixture tests; [#627](https://github.com/scott-r-lindsey/foom/pull/627) detaches bounded login-shell reads. It predates this census. Need the exact failed case and spawn/read/close phases to establish whether the note means that probe or shell launch readiness. |
| Host enrollment | Enrollment and draft preflight are now separate scenarios; [#1111](https://github.com/scott-r-lindsey/foom/pull/1111) waits for draft preflight before smoke enrollment. The extension's executed enrollment/preflight case-name matches pass. Need the old phase trace to distinguish bootstrap upload, preflight, UI confirmation and management response. |

The ESRCH observation and unit-hook timeouts remain with #1050. Branch-specific capability-array, tile/layout and concurrent-review count regressions from the old census are not classified as flakes. This PR references #1138 because the unresolved signatures above still need evidence; it does not claim full issue closure.

## Artifact identity inventory

This inventory preserves all available first-attempt and later-attempt uploads. IDs are ordered by upload time within each run; duplicate artifact names are intentionally retained as distinct IDs.

| Run | Artifact IDs |
| --- | --- |
| 42545513976 | 13643183694, 13643143997, 13643861296, 13643442892, 13643053082, 13644065148, 13643038342, 13643358525, 13644065468, 13643207957, 13643916538, 13643906890, 13642794895, 13643329601, 13643709113, 13644242868, 13644084497 |
| 42551694817 | 13646042346, 13645369889, 13645248838, 13645683548, 13646350413, 13646151244, 13645509689, 13645099943, 13645632833, 13646281751, 13645989913, 13645629263, 13647105749, 13646897524, 13647516604, 13648500943, 13649190380 |
| 42551903310 | 13645823235, 13645807263, 13645888362, 13645803756, 13646585006, 13645933400, 13645154895, 13646400540, 13646043326, 13646780320, 13646543592, 13646787688, 13647271598, 13647750111, 13646439540, 13648420047, 13647908408 |
| 42552709991 | 13645889851, 13646491950, 13646183528, 13646925150, 13645733697, 13646576103, 13645579167, 13646203939, 13646029855, 13646935699, 13647096425, 13648251569, 13648228561, 13648591654, 13648123403, 13649560206 |
| 42589044729 | 13660299234, 13660324408, 13661046867, 13660159040, 13660114189, 13660414528, 13660464451, 13660544729, 13661092942, 13661746896, 13662675609, 13663065813, 13663705179, 13662758653, 13662884819, 13664059046, 13665936430, 13666267710, 13667586630 |
| 42761463525 | 13738272020, 13737913696, 13737903767, 13737529665, 13738063356, 13737519830, 13737864018, 13737504152, 13738168220, 13738391752, 13738043924, 13738243065, 13738033952, 13738278031, 13738831424, 13746706006 |
