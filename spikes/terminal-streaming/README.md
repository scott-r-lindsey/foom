# Visible streaming measurements for #711 / PR #715

Measured on Linux x64 / i7-14700KF (28 logical CPUs), Electron 44.9.3,
xterm 6.0.0, 1800×1200, DOM fallback with GPU acceleration disabled. Nine
isolated fixture shells: five streaming tiles, three detached streams and one
focused echo shell. Each producer writes 100 78-byte CRLF lines every 20 ms.
No real agent CLI, global agent configuration, network fixture or sandbox change.
GPU-process CPU below is software compositor CPU, not hardware WebGL evidence.
Echo includes Playwright overhead, not physical key-to-photon latency.

**Outcome:** no visible-streaming candidate is retained. The covered-tile win
remains, but this investigation does not claim a visible-streaming improvement.
Frame coalescing did not reliably reduce CPU; compositor promotion shifted work
onto the GPU process and containment/dimming alternatives did not meet the
CPU/latency requirements. A deeper xterm DOM-renderer change or a separately
measured hardware-renderer investigation is needed rather than forcing these
Foom-side changes.

## Profile before choosing a change

`visible-profile-streaming` captures 5.176 seconds of steady visible output.
There were 2,476 data messages (10,317,450 UTF-16 units), 2,480 ACKs, 52 activity
batches, zero terminal state changes, zero resizes and zero replaced sidebar rows.
The small mismatch in message/ACK counts reflects in-flight writes and slightly
different counter/metric windows.

V8 sampling with an external source map attributed about 66 ms to xterm parsing/
buffer work, 156 ms to xterm rendering/selection, 5.4 ms to renderer controller/IPC
JS, 5.5 ms to light/activity JS, 1.5 ms to React and no samples to sound-controller
JS. These are sampled stacks, not complete cross-process IPC costs. Another
3,175 ms was unclassified `(program)` time, 1,769 ms idle and 39 ms GC; do not
interpret that sampling output as a closed CPU budget.

The Chromium trace explains the larger native rendering cost:

| Trace region | Wall duration in capture |
| --- | ---: |
| Renderer main-thread RunTask | 2,124 ms |
| Raster worker tasks | 1,039 ms |
| Compositor RunTask | 284 ms |
| JS FunctionCall | 859 ms |
| UpdateLayoutTree / Layout / Paint | 212 / 325 / 224 ms |
| FireAnimationFrame / TimerFire | 493 / 379 ms |

These regions overlap/nest; **do not sum them**. Source-mapped hot methods include
`DomRendererRowFactory.createRow`, `replaceChildren`, `WidthCache.get`, and, for
parsing, `InputHandler.print`, `BufferLine` and `EscapeSequenceParser.parse`.
xterm's normal row refresh and selection redraw can both regenerate rows.

The steady fixture produced no attention/state events. Source inspection confirms
activity updates bypass React (`live-board-source.ts` updates rates and notifies
activity listeners without publishing the row snapshot). Sound subscribes to
structural/execution state, not output chunks; the shell-only fixture does not
exercise agent working audio. Thus this profile does not establish costs for
agent lifecycle transitions, but finds no per-chunk React, attention or sound
work to remove from this steady stream.

## Frame-coalescing matrix: rejected

Fresh app/profile for every run, one benchmark app at a time under the shared
machine lock. Three interleaved runs per compiled renderer bundle, reversing
order on run 2. Ten echo probes per run. CPU is percent of one core; echo is the
median of each run, then the median across runs. Parentheses show min–max across
the three runs. [coalescer-results.json](coalescer-results.json) preserves the
individual measurements and 30 echo samples per variant.

| Variant | Renderer CPU | GPU CPU | Echo ms |
| --- | ---: | ---: | ---: |
| Baseline | 78.50 (77.19–80.24) | 36.46 (34.74–36.83) | 11.92 (10.89–13.19) |
| Eager first write, then frame coalescing | 79.66 (78.25–87.35) | 34.78 (34.33–35.79) | 11.64 (11.49–13.25) |
| Frame coalescing, focused terminal bypass | 76.50 (75.84–81.93) | 35.35 (33.41–37.31) | 13.02 (12.71–13.16) |

The eager prototype immediately writes isolated output, then groups sustained
chunks per rAF; the frame prototype queues only unfocused streams and leaves the
focused terminal's output immediate. Both preserve order and ACK only parsed
UTF-16 units, grouping counts separately by terminal ID and attachment token.
They reduce ACKs from roughly 2,400–2,500 to about 1,570 per capture, but that saving
did not produce a reliable renderer/GPU improvement. Eager coalescing raised rAF
callbacks from about 2,950 to 5,020 and paint events from about 2,290 to 2,700.
The simpler frame prototype had overlapping CPU ranges and slower measured echo
medians. Neither ships. An independent earlier three-pair eager experiment also
regressed median renderer CPU (71.77→76.85%).

## Verified CSS matrix: rejected

Three interleaved runs per variant, **30 phase-varied probes per run**, same
production renderer bundle. Computed-style assertions and the saved
`appliedStyles` verify each actual variant before starting capture. Probe gaps
vary deterministically so keystrokes do not stay locked to a single 60 Hz frame
phase. These longer captures last about 16 seconds. See
[css-results.json](css-results.json) for all 90 echo samples per variant and their
CPU, frame and process-memory spreads.

| Variant | Renderer CPU | GPU CPU | Echo ms |
| --- | ---: | ---: | ---: |
| Baseline | 89.65 (73.50–90.50) | 35.86 (30.15–37.87) | 12.81 (12.73–17.28) |
| DOM screen compositor promotion | 72.36 (60.05–72.42) | 50.58 (44.45–52.49) | 14.22 (12.83–14.51) |
| Strict fixed-size DOM row containment | 85.71 (83.92–86.26) | 34.24 (33.97–35.35) | 14.69 (13.95–15.89) |
| Promotion + containment | 72.61 (69.92–74.19) | 51.03 (49.73–51.20) | 15.76 (13.32–15.81) |

Promotion moves cost between processes rather than giving a safe overall win:
software GPU-process CPU increases about 41%, and its working set rises about
12 MiB. Containment has overlapping renderer CPU ranges and worse echo medians.
The combination retains the GPU regression. These rules are not in application CSS.
Process working set is **not GPU allocation attribution**.

A preliminary CSS series was discarded: its optional style flags had not been
inserted into the benchmark. Those numbers are not evidence for any CSS effect
and are not included here. The coalescer bundles were different compiled bundles,
with the ACK reduction independently confirming that those variants were active.
The verified series above replaces all preliminary CSS comparisons.

## Dimming/compositing alternative: rejected

A final three-pair batch tested replacing the unfocused opacity group with a
20% constant terminal-background overlay. This was a rendering experiment only;
no visual-equivalence claim or application change is made. Computed shell opacity
and pseudo-element background are saved in `appliedStyles`.
[dimming-results.json](dimming-results.json) contains all individual measurements.

| Variant | Renderer CPU | GPU CPU | Echo ms |
| --- | ---: | ---: | ---: |
| Baseline | 90.49 (87.43–91.46) | 36.85 (36.04–37.34) | 13.69 (13.62–14.64) |
| Constant-background overlay | 89.11 (87.25–89.23) | 36.81 (36.44–38.47) | 14.24 (13.05–14.39) |

CPU ranges overlap, GPU cost is effectively unchanged, and renderer/GPU-process
working sets increase by about 11 MiB each. Not worth changing the presentation.

Absolute CPU varies between batches on this shared machine; compare interleaved
variants within a batch. No hardware WebGL, GPU allocation, or physical input
latency claim follows from these software-compositor measurements.

## Reproduction

Run from the repository root with Node 24 and the frozen-lockfile dependencies.
Wrap heavy commands in the shared `heavy.sh` when working on this shared machine.

```sh
pnpm run build
# Both use the unchanged production write path. 1 tries the rejected layer rule;
# 0 explicitly verifies the unpromoted baseline.
MEASURE_LABEL=base-1 MEASURE_LAYER=0 MEASURE_PROBES=30 MEASURE_VISIBLE_ONLY=1 xvfb-run -a node --test tests/electron/streaming-measurement.js
MEASURE_LABEL=layer-1 MEASURE_LAYER=1 MEASURE_PROBES=30 MEASURE_VISIBLE_ONLY=1 xvfb-run -a node --test tests/electron/streaming-measurement.js
# Repeat three pairs, reversing their order on the middle pair.
```

`MEASURE_CONTAIN_ROWS=1` adds the rejected strict row-containment candidate.
`MEASURE_DIM_OVERLAY=1` adds the rejected dimming-overlay candidate.
`MEASURE_VISIBLE_ONLY=1` omits the covered phase; the default still measures both.
`MEASURE_PROBES` accepts 1–30 and defaults to 10. Raw JSON, traces and profiles
stay in ignored `test-results/`, never in packaged assets.

```sh
node spikes/terminal-streaming/build-profile.mjs
MEASURE_LABEL=profile MEASURE_PROFILE=1 MEASURE_LAYER=0 MEASURE_VISIBLE_ONLY=1 xvfb-run -a node --test tests/electron/streaming-measurement.js
node spikes/terminal-streaming/profile.cjs test-results/profile-streaming.cpuprofile build/renderer/renderer.js.map
node spikes/terminal-streaming/summarize.mjs verified
```

External source maps are for offline analysis only; no asset allowlist or CSP
change is made. Use the map generated with that exact renderer bundle. The saved
[profile-summary.json](profile-summary.json) belongs to the pre-change profile.

To reproduce the rejected coalescers, use a disposable development worktree:
copy either `output-writer.mts` (eager) or `output-writer-frame.mts` (frame) to
`src/renderer/terminal/output-writer.ts`, apply `integration.patch`, rebuild and run
the same matrix. Revert those experimental source edits afterwards. The prototypes
preserve byte order and group ACK counts by terminal ID and attachment token only
after parsing. Focused terminals bypass batching so keyboard echo is immediate.
The controller experiment flushes before hide, exit, resize and attachment reset.

```sh
node --test spikes/terminal-streaming/fidelity.mjs
```

Eight reference tests pass across both prototypes: isolated/focused echo, mixed
1/7/4095/32768/65536-sized chunks, delayed token-scoped ACKs, 262144/65536 view
backpressure watermarks, flush/disposal, byte-identical serialized Unicode/ANSI
normal and alternate buffers, and ordered resize boundaries. Explicit parser
barriers order resize stages in the reference test. These are rejected research
prototypes, not application modules or a new shipping write path.
