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
| 42761463525 / **13738033952** | macOS replay: two SSH owners before deliberate loss | 9.837 | Acknowledgement burst reproduced; coalesced in #1173 |

## Historical ranking and disposition

The fixed 60-run sample ranks sound (3 failures, Linux/macOS, **11.75–13.23 s**), config probe (2, macOS, **8.08–13.94 s**), shell-exit deletion (1, macOS, **14.06 s**), and hdiutil attach (1 job, outside JUnit). Group cleanup moved to [#1146](https://github.com/scott-r-lindsey/foom/issues/1146), with its fix in [#1147](https://github.com/scott-r-lindsey/foom/pull/1147). Remote quit is separately fixed by [#1103](https://github.com/scott-r-lindsey/foom/pull/1103).

### Footer sound

[Original job](https://github.com/scott-r-lindsey/foom/actions/runs/42395183771/job/128470957731), first-attempt artifact **13584640276**, reaches the expected slider value but reports zero playback starts. It does not record keydown/input/keyup, the settings used by the sample callback, sink identity, or asynchronous decode cancellation. [#918](https://github.com/scott-r-lindsey/foom/pull/918) already retains pending unmuted slider settings before a delayed parent render; that fix predates this failure and cannot be claimed as its resolution. Current unit regressions cover delayed parent rerender for pointer and keyboard release. The 18 passing extension executions rule out an unconditional failure on those revisions, but not an intermittent sample/cancellation ordering defect. Needed: a natural failed native-input trace with callback settings, sink/decode generation and playback-start order. No speculative sound change is included.

### Config probe selector

[Original job](https://github.com/scott-r-lindsey/foom/actions/runs/42365888837/job/128383800010), first-attempt artifact **13573054992**, supplies the cause directly: `.config-dock .board-row` filtered by `Probe` resolves to two elements. The parent config row contains `Probe waiting`; the actual probe contains its `Probe` label. The original assertion can run before or after that parent status appears. This is a strict-locator ambiguity, not evidence that the probe is missing or late. PR #1173 selects the probe's actual workspace terminal ID and deliberately rechecks its visibility after the parent's reminder appears. The visibility, disclosure, driver, attention, stop, capture and cleanup assertions remain. A controlled local run first settled the parent reminder while retaining the old selector, then reproduced the same two-row strict-mode failure; fixture cleanup completed normally.

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

The ESRCH observation and unit-hook timeouts remain with #1050. Branch-specific capability-array, tile/layout and concurrent-review count regressions from the old census are not classified as flakes. PR #1173 referenced #1138 because these signatures still needed evidence. The follow-up below distinguishes the bounded investigation result from proof that every historical symptom is fixed.

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

## Follow-up census (2026-11-17)

This is a separate bounded sample after merged [#1173](https://github.com/scott-r-lindsey/foom/pull/1173), downloaded on 2026-11-17. It selects the thirteen main runs below from 2026-11-15 16:26 through 2026-11-16 20:51 UTC, including two cancelled reruns with interrupted reports. It is not a census of every intervening push. Every available `electron-results-*` upload for each selected run was downloaded by numeric artifact ID, including duplicate names from independent attempts. The API returns no artifacts for the additionally queried 2026-11-11 run **42994735476**; it contributes no inferred results. The old six-run sample above remains separate.

| Run | Latest attempt / outcome at download | Electron uploads |
| --- | --- | ---: |
| [43735490367](https://github.com/scott-r-lindsey/foom/actions/runs/43735490367) | 1 / failure | 15 |
| [43759810272](https://github.com/scott-r-lindsey/foom/actions/runs/43759810272) | 3 / success | 16 |
| [43800091934](https://github.com/scott-r-lindsey/foom/actions/runs/43800091934) | 2 / success | 16 |
| [43810483925](https://github.com/scott-r-lindsey/foom/actions/runs/43810483925) | 1 / failure | 15 |
| [43822818958](https://github.com/scott-r-lindsey/foom/actions/runs/43822818958) | 1 / failure | 15 |
| [43840785089](https://github.com/scott-r-lindsey/foom/actions/runs/43840785089) | 1 / failure | 15 |
| [43841807308](https://github.com/scott-r-lindsey/foom/actions/runs/43841807308) | 1 / success | 15 |
| [43853317951](https://github.com/scott-r-lindsey/foom/actions/runs/43853317951) | 2 / success | 16 |
| [43901560619](https://github.com/scott-r-lindsey/foom/actions/runs/43901560619) | 2 / cancelled | 16 |
| [43909947998](https://github.com/scott-r-lindsey/foom/actions/runs/43909947998) | 2 / success | 19 |
| [43936089811](https://github.com/scott-r-lindsey/foom/actions/runs/43936089811) | 2 / success | 17 |
| [43946639936](https://github.com/scott-r-lindsey/foom/actions/runs/43946639936) | 2 / cancelled | 17 |
| [43954033358](https://github.com/scott-r-lindsey/foom/actions/runs/43954033358) | 2 / success | 16 |

The 208 uploads span 2026-11-15 16:34:53 through 2026-11-16 21:21:26 UTC and contain eight incomplete XML reports, each only a 52-byte opening envelope. Their IDs are **14217276059**, **14219568672**, **14244376925**, **14246912760**, **14247229837**, **14247523602**, **14261478330**, **14268968559**. They supply no completed-case observations. Successful later attempts do not erase these interrupted uploads. Latest run outcome is not an outcome for every attempt or report.

| Named case | Failed / executed observations | JUnit duration range, seconds |
| --- | ---: | ---: |
| Footer zoom/master volume | 1 / 39 | 2.267–13.151 |
| Config probe CLI | 0 / 39 | 8.253–62.344 |
| Running-shell worktree deletion | 0 / 39 | 2.923–16.408 |
| Same-PTY replay after SSH loss | 0 / 27 | 7.089–16.841 |
| Manifest-only v2 agent | 1 / 40 | 4.122–19.428 |
| Native-hidden board startup | 1 / 40 | 1.642–20.120 |
| Host plugin install consent | 0 / 27 | 4.384–15.374 |
| Unavailable-host Forget | 0 / 26 | 10.249–22.405 |

Counts exclude platform skips and interrupted reports. Passing executions do not establish recovery. All nine failed named observations in this sample are retained below; unrelated failures are not relabelled as one cause.

| Run / original artifact | Failure | JUnit seconds | Disposition |
| --- | --- | ---: | --- |
| 43735490367 / **14170676055** | Hosts status classification stays consistent with sealed catalog omission | 2.092 | Extra repository discovery in request window; #1199 observer/drain fix is on current main |
| 43759810272 / **14181705796** | config agents receive only the bundled manual and revoke the attachment on exit | 29.932 | Config-agent exit predicate; no exit/admission trace, not attributed to capture publication |
| 43800091934 / **14196438405** | extended user themes apply through both bridges and reject malformed theme data | 14.870 | User-theme sidebar black versus white; no theme publication trace |
| 43810483925 / **14200702699** | extended user themes apply through both bridges and reject malformed theme data | 40.265 | Same user-theme assertion on Windows; no shared cause established |
| 43822818958 / **14206000717** | Default themes follow native appearance live and Settings theme menus share the config launcher | 14.861 | Default theme palette; current fixture synchronization documented in electron-fixtures.md |
| 43822818958 / **14207140861** | first-run rail shares the Theme menu and saves its live selection | 13.229 | First-run resolved theme label; current fixture synchronization documented in electron-fixtures.md |
| 43909947998 / **14246914937** | sidebar footer zoom and master volume stay synchronized and presets are absent | 13.151 | Zero sound starts recurs; ordering still missing |
| 43909947998 / **14248137208** | a manifest-only v2 fixture agent loads from the config folder, reloads edits and is withdrawn when invalid | 8.250 | Capture publication ordering reproduced and fixed; see below |
| 43936089811 / **14262436416** | shared board startup restores a native-hidden CDP-visible board and delivers frames | 20.120 | Startup ACL command killed; see below |

### Proven fixture capture publication race

In **43909947998 / 14248137208**, macOS reads `argv.json.env` and gets ENOENT immediately after its argv readiness poll succeeds. The fixture writes `argv.json`, then `.mcp`, then `.env` as three separate synchronous operations in a different process. Observing the first file does not acknowledge the later writes. A controlled Xvfb run retained that first publication and held the subsequent captures: the unchanged reader reproduced the exact `.env` ENOENT in 4.414 seconds, with normal teardown. No CPU or I/O load was generated.

The fixture now writes `.mcp` and `.env` before publishing argv. The existing poll parses argv successfully before reading either supporting capture, preserving every literal-argument, MCP attachment, bypass, hook, reload and revocation assertion. The controlled hold is not retained in the test. This proves the ordering defect without claiming the historical artifact measured the writer's individual file events. It does not explain the distinct config-agent native-exit predicate failure.

### Native-hidden startup: ACL failure before the test body

**43936089811 / 14262436416** reports a closed Electron target from `boardPage`'s diagnostic `nativeState` call during `launchApp`, before the test's hide/activate/frame body. Browser stderr first records image-paste cleanup failure, then startup failure from `windowsAcl`: PowerShell is killed with SIGTERM, null exit code and empty stdout/stderr. Current `private-file-permissions.ts` bounds that command at five seconds. The main process then exits, explaining the later target-closed exception.

This rules out the test's hidden-board animation-frame predicate as the immediate failure. It does not show whether startup, SID resolution, ACL inspection or ACL mutation consumed the command budget. Need bounded path-free subprocess phase timestamps and native exit/pipe-close facts on a natural recurrence. No ACL relaxation, retry, deadline increase or speculative native-window change is justified.

### Sound recurrence

**43909947998 / 14246914937** repeats zero starts after the slider reaches 5, at the same sample assertion as the historical sound group. Its 13.151-second total is not decode time. The report still lacks keyup/sample settings, audio-context identity and decode/cancellation order. The prior 0/18 result above is now explicitly historical, not a recovery claim. The required evidence remains the native-input and sink-generation trace described under Footer sound.

### Plugin consent and unavailable-host Forget

The selected main reports contain 27 passing plugin-consent executions and 26 passing Forget executions, but neither requested failing assertion. Do not identify a cause from those names alone. Current main already includes [#1218](https://github.com/scott-r-lindsey/foom/pull/1218)'s superseded-sidebar drain for Forget; [fixture documentation](../electron-fixtures.md#forget-session-request-window-1217) records its controlled held-read reproduction and retained exact request-log assertion. A later failure must be compared against its actual revision and assertion. The Agents scrolling fixes (#1193/#1213) concern a different case from plugin consent and cannot resolve it by name association. Needed for consent: original artifact/stack, recipe writes, reported PTY exit, inspection requests and trusted-dialog presentation/input order. Needed for Forget: original artifact/stack, sidebar reads and SSH-log capture/recovery ordering.

### Removal-confirmation addendum: no shared cause established

The parent supplied main run **44037904482** at `efe541cdfee293af2335283cdac202b63eab4dd5` after this sample was selected. Only its two named failing artifacts were downloaded for this addendum; they are excluded from the table counts and full-run inventory.

- Windows 2/5, **14308816891**, queued automatic withdrawal: 39.443 seconds, operation status is terminal `failed`, reason `git_failed`, detail `Git could not complete worktree removal`. Its recorded operation advances from 07:23:07.762 to 07:23:19.735 UTC. The remaining 30-second status poll cannot turn a failed operation into success. Need the particular Git command, result and mutation/lock ordering; this is not evidence of a missed confirmation withdrawal after successful removal.
- macOS 6/7, **14308972540**, cleanup before review on one board: 23.319 seconds, times out at `workspace-cleanup.test.js:883` waiting for the approved front checkout's path to disappear after clicking Delete. This precedes looking up the next queued review. No per-command removal result is recorded. Need native click/acceptance, cleanup progress, Git result and checkout-membership order.

[#1223](https://github.com/scott-r-lindsey/foom/pull/1223) changed a separate external-worktree cleanup completion fixture. These two artifacts do not prove a common cause with each other, that fixture or the three requested signatures. They remain evidence-only here; no removal-confirmation code change is included.

### Follow-up artifact inventory

All available uploads for each selected run, in API order, preserving duplicate names by ID:

| Run | Artifact IDs |
| --- | --- |
| 43735490367 | 14171641633, 14171051531, 14171007904, 14170960483, 14170676055, 14170651397, 14170586733, 14170529053, 14170433081, 14170413180, 14170043592, 14169884837, 14169719071, 14169599050, 14169439941 |
| 43759810272 | 14183498866, 14181705796, 14181661087, 14180725006, 14180595003, 14180585787, 14180491650, 14180429844, 14180400915, 14180368964, 14180361354, 14180350585, 14180231284, 14179978416, 14179973305, 14179829361 |
| 43800091934 | 14198837795, 14197851279, 14196827616, 14196824433, 14196695058, 14196580190, 14196438405, 14196421167, 14196392753, 14196319639, 14196079968, 14196014149, 14195773728, 14195489329, 14195474066, 14195309740 |
| 43810483925 | 14201661137, 14201601153, 14201395594, 14201138061, 14200989385, 14200941185, 14200935755, 14200838559, 14200737216, 14200702699, 14200692367, 14200438051, 14199999732, 14199974221, 14199929139 |
| 43822818958 | 14207140861, 14206981429, 14206967288, 14206441906, 14206112563, 14206071283, 14206000717, 14205752204, 14205737281, 14205606716, 14205583856, 14205577161, 14205572755, 14205448482, 14204869408 |
| 43840785089 | 14217276059, 14216796304, 14216630493, 14216566748, 14214670836, 14214134991, 14213936179, 14213871647, 14213227179, 14213053246, 14213013855, 14212814907, 14212759414, 14212734895, 14212609971 |
| 43841807308 | 14217625545, 14217122453, 14217112520, 14217053165, 14216987762, 14216821833, 14215020077, 14214945299, 14214410864, 14214262094, 14214241382, 14214043107, 14213718239, 14213623286, 14213149570 |
| 43853317951 | 14222922003, 14221177196, 14220836014, 14220701748, 14220586931, 14220546824, 14220394970, 14220372077, 14220171847, 14219793329, 14219774007, 14219723580, 14219568672, 14219538100, 14219528226, 14219333353 |
| 43901560619 | 14246912760, 14245652358, 14245320084, 14244980411, 14244975272, 14244950227, 14244625452, 14244376925, 14244116997, 14243665654, 14243400991, 14243215757, 14242660931, 14241833324, 14241464142, 14241429071 |
| 43909947998 | 14252570578, 14252376017, 14251331330, 14250486729, 14249332473, 14248601641, 14248596740, 14248377680, 14248377348, 14248222370, 14248137208, 14247627920, 14247527392, 14247523602, 14247308773, 14247229837, 14247198725, 14247019802, 14246914937 |
| 43936089811 | 14264561267, 14264041344, 14263150034, 14263140255, 14263036657, 14262890063, 14262436416, 14262421312, 14262401278, 14262021314, 14261551792, 14261478330, 14261477531, 14261441433, 14261371635, 14261223326, 14260454391 |
| 43946639936 | 14269216629, 14268968559, 14268720978, 14267952214, 14267800038, 14267477308, 14267470595, 14267440001, 14267350153, 14267307636, 14266764467, 14266722302, 14266206537, 14266036938, 14265962378, 14265574288, 14265409822 |
| 43954033358 | 14273780026, 14273071163, 14273025680, 14272988227, 14272860995, 14272756066, 14272691559, 14272661230, 14272542614, 14272248133, 14271758594, 14271658208, 14271463507, 14271448187, 14270908106, 14269609897 |
