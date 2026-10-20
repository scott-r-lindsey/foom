# Agent Detection

### Detection and resume paste

Detection rules contain: required id, state (working/blocked/idle/unknown),
priority, region (title/bottom/after_horizontal_rule), match, reason; optional lines,
not, comment. IDs use [a-z][a-z0-9_-]* <=40 (underscore preserves bundled rule IDs).
Priority is integer 0–2000. lines 1–40, reason <=128, comment <=256; not <=8 matcher objects.
Matcher has contains? and regex? arrays <=8 strings each, at least one; <=128 each.
Contains entries are conjunctive, case-insensitive as today's detector; regex subset
uses boundedRegex (no groups, repetitions, alternation, backreferences). Matcher
exclusions negate each matching matcher; All contains and regex entries in one matcher are conjunctive. Rules sort descending priority, stable
array order on ties. Bottom defaults to the last 12 nonempty lines; after_horizontal_rule uses the region after the last line of at least three horizontal-divider characters, or all 40 lines if absent, as today. Existing 40-line/500-character line caps, title 512-character
cap and 5 ms evaluation budget stay in code. No new whole-screen or regex engine.

`resumePaste` is a bounded token pattern, not an unbounded capture regex. Trim outer
whitespace; reject internal CR/LF and input >512 characters; split on literal
space/tab; exactly command, selector, ID. Literal command/selector plus the fixed
conversation validator bound the ID capture. This expresses all current forms with
no unsafe quantifiers/groups. Bare valid IDs remain engine behavior with an explicit
agent choice. No quotes, paths, shell syntax, extra flags, optional picker/name/prefix
resume forms, equals form or command execution. Ambiguous matches across active
plugins require explicit provider selection. Renderer may receive validated public
patterns but raw paste stays local; main checks the loaded provider and ID again.

## Detection bounds

At most 64 rules, eight strings per matcher and 128 characters per pattern. Rules select working, blocked, idle or unknown and title, bottom or after_horizontal_rule regions. Match and optional not contain contains or regex arrays. Every regex uses `boundedRegex`; groups, repetition, alternation and backreferences are forbidden. The existing screen-tail and evaluation-budget limits apply.
