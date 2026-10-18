# Sidebar activity trace investigation (#412)

The measured rates in the [issue comments](https://github.com/scott-r-lindsey/foom/issues/412)
are already large enough for the existing scale. The loss found in the renderer is
that the trace used the glow envelope: a rate sampled no faster than 3 Hz, followed
by 120 ms attack / 700 ms release, then sampled again at 4 Hz. This further flattens
variation after the host's 500 ms filter. A peak arriving between target updates can
be discarded altogether. Raising sensitivity would instead saturate working agents.

The trace now retains the highest mapped rate observed in each quarter-second
window, independently of the glow. Reduced motion retains a one-second peak and
rounds it to 0, 1/3, 2/3 or 1. The glow retains its existing hold and smoothing.
A replay with one 639-byte redraw each second through the host's 500 ms filter
produces 2.9 px of trace variation after settling, versus 2.0 px with the old glow
sampling (50 ms renderer ticks, measured over seconds 12–20). This preserves
variation without inventing a pulse when output is steady.
The independent agent/shell mapping functions share the existing 200 B/s visibility
and 4,000 B/s saturation knees, justified by the measured working levels below.

## Pipeline audit

1. `terminal-manager.ts` calls `TerminalActivityMeter.output` on raw PTY data before
   xterm parsing, renderer delivery and view throttling. It counts UTF-8 bytes,
   including escape sequences, even with no attached view.
2. `terminal-activity.ts` uses elapsed seconds, not a fixed assumed window:
   `rate = previous * exp(-dt/0.5) + bytes/dt * (1-exp(-dt/0.5))`.
   One 100 ms host timer emits changed rates in a batch. Rates under 0.1 B/s
   become zero; the timer sleeps after all meters are quiet and zero.
3. Host client filters live terminal IDs; main's broker filters owned IDs. Neither
   changes rate values. Preload validates complete batches of nonnegative finite
   rates and IDs. `live-board-source.ts` caches rates, forwards activity outside
   React, and replays the cache to new subscribers. No extra batching window exists.
4. `movingLight` admits only live Working agents and non-attention running shells.
   Needs you never moves, even if it prints. This is intentional: output alone is
   not evidence that an agent has resumed. Nonmoving/exited/closed histories are
   dropped; launch versions discard old rates and histories.
5. `LightHistory` previously fed its doubly sampled/smoothed glow into history.
   Its trace now accumulates peaks independently. Tests cover a 100 ms peak that
   the glow's target hold completely misses, normal/reduced motion, bounded history,
   recorded-screen replay through the host meter, and decay to the zero baseline.
6. The sidebar subscribes via a disposable DOM controller. Its path uses timestamps
   over eight seconds, at most 33 points, x=0–34 and y=11−10×level. CSS displays
   the 34×12 viewBox without reducing its height, with a 1.2 px stroke at 80% opacity
   in the light's state color. There is no hidden SVG scale loss. Steady rates
   produce steady elevated lines; only rate changes should create variation.

## Recorded evidence and tile-size replay

The independent real-CLI measurements in #412 used a 160×48 PTY:

| Agent/phase | UTF-8 bytes/s | Mapped level | Height above zero |
|---|---:|---:|---:|
| Claude working | 500–1,400 | 0.56–0.78 | 5.6–7.8 px |
| Codex working | ~2,000 | 0.85 | 8.5 px |
| Codex streaming | 7,000–65,000 | 1 | 10 px |
| Both idle | 0 | 0 | 0 px |

No real CLI was run for this implementation. The checked-in detection captures
retain recorded screen text, not raw ANSI streams or timing. The reproducible
`tests/unit/terminal-host/activity-trace-replay.test.ts` replays the Claude working
and Codex startup screen text at three sizes using an explicit full-viewport redraw:
each row gets cursor positioning, recorded text clipped/padded to the width, then
clear-to-end. These are fixture-renderer byte counts, **not measurements of how the
real CLIs choose dirty regions**. At one redraw per second the values also equal B/s;
at another frequency multiply by redraws/s.

| Viewport | Cells | Claude bytes/redraw | Codex bytes/redraw |
|---|---:|---:|---:|
| 40×12 | 480 | 639 | 591 |
| 80×24 | 1,920 | 2,199 | 2,157 |
| 160×48 | 7,680 | 8,657 | 8,157 |

Halving both dimensions cuts this full redraw by about 74%; quartering them cuts
it by about 93%. By contrast, a fixture spinner-only redraw (`CR`, clear line,
`✻ Spinning…`) is 19 UTF-8 bytes at every size: 190 B/s at 10 Hz. Thus terminal
area alone cannot normalize the rate: a CLI may redraw a viewport, several rows,
or just a spinner. Do not extrapolate the 160×48 real rates by area or add a
viewport-based multiplier. Further real-size measurements would be separate
manual evidence, never a test-suite invocation of an installed agent CLI.
