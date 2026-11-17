# Settings reset reported on 2026-11-16 (#1234)

## Conclusion and evidence boundary

Code and isolated fixtures reproduce a whole-config replacement through
`ConfigService.writeSettings` before #1228. A Settings save serialized
`{ kind: "settings", ...this.applied.values, ...patch }` and atomically renamed
that file over the shared `config/settings.json`. It did **not** reread the file
or literally catch a read error and substitute an empty object inside the writer.
If the service's applied baseline was empty, saving the agent checkboxes wrote
only that map: the omitted `concurrentChildren` and `interfaceScale` then resolved
to 4 and 100. A stale baseline could likewise erase newer preferences from
another profile before the watcher scanned them.

#1228 prevents the reproduced paths by scanning fresh bytes before merging a
patch, adopting safe edits through the existing approval gate, and rejecting the
save if the file is missing, invalid or unreadable. No additional production
change is needed for these reproductions.

This confirms a destructive code path consistent with the report, **not the
historical trigger on November 16**. No incident file, logs or real profile was
inspected. A transient read/parse failure, stale second profile, downgrade, or
an already-replaced valid file cannot be distinguished from the report alone.
The #1224 explanation covers agents only; it does not explain losing an explicit
child limit of 16 or saved zoom. Closing #1234 must not turn this fixture evidence
into a claim that the actual incident trigger was proved.

## Paths considered

- **#1174 upgrade:** commit `19e08f225260ee6a34aa186ff7cfcc34e3a7dfac`
  changes absent agent keys to disabled. Current version-1 profile migration
  preserves an explicit limit of 16 and scale of 150, with either an absent or
  explicit agents map. It creates shared settings only if missing, without
  replacing an existing file. Existing adoption and startup-race fixtures cover
  an already-existing shared file. The default change alone cannot explain the
  numeric reset.
- **Cold read/parse failure:** without a verified digest/copy, startup applies
  defaults and records the file rejection. Previously a later agent save could
  overwrite the rejected file from that empty applied baseline. The regression
  injects a settings-only read failure or partial JSON at startup and keeps it
  in force through the save. Main rejects the save and preserves the external
  bytes; once the writer finishes or the read failure clears, retrying adopts
  the saved 16/150 values and retains the enabled agents. No actual updater,
  sharing lock, or file corruption is asserted as the incident trigger.
- **Two profiles:** ordinary development and packaged profiles have independent
  baselines/queues but share the HOME-keyed config directory. The regression
  runs two independent services against one temporary config directory. Both
  start empty, the first saves 16/150 and enabled agents, then the second saves
  another enabled agent before its watcher runs. Main preserves all preferences.
  This models an ordered stale write, not simultaneous writers between the read
  and rename: there is no cross-process transaction or lock added by #1228.
- **Two instances of one profile:** `runApplication` selects the profile before
  acquiring Electron's single-instance lock; a losing launch exits before opening
  stores. Distinct profiles can still run together. Switching profiles can also
  change profile-only settings without changing shared config.
- **Downgrade:** older pre-#1174 profile validators require the three historical
  provider keys in `agentBypassAcknowledged`. Sparse consent maps can reject a
  whole profile and cause `SettingsStore.open` to rewrite profile defaults.
  That separate fallback remains in current code for invalid profile state;
  #1228 changes the shared-config writer, not this loader. For migrated version-2
  profiles, child limit and zoom belong to shared config, so a profile reset
  alone is not evidence that the shared file was replaced. A valid but already
  stripped config file also cannot be repaired automatically by #1228.

## Regression and countercheck

`tests/unit/main/config/settings-reset.test.ts` uses only temporary directories,
fixture watchers, production config defaults and a settings-only mocked read
failure. It covers two-profile stale writes, both cold-start failures, and both
version-1 migration shapes. The three writer regressions fail when only the
pre-save scan/rejection block from #1228 is removed, with the rest of current main
and all assertions unchanged; the migration cases still pass. Restoring the block
makes all five cases pass. No agents, network, shell startup files or real
profiles are used by these tests.

## Recovery limits

`settings-before-optional-agents.json` is a private, one-time snapshot of the
first valid profile loaded after #1174 (implementing #1122), excluding retired
inference fields. It is never refreshed or overwritten. The migration regression
checks that a version-1 snapshot contains the original explicit 16/150 values.
Those values are recoverable from that snapshot if it predates the loss.

For version 2, config keys are removed from the profile's `settings` object.
The snapshot may instead contain `configText` plus its `configDigest`: that copy
is a recovery candidate only if its digest matches and the JSON validates.
Restoring a profile backup alone does not overwrite an existing shared config;
that file wins migration. A validated copy would need to be restored separately
to the shared settings file while all sharing apps are stopped. The live profile
also keeps its last applied `configText`, but a later successful destructive save
updates it to the stripped file, so it is not a durable backup. Neither snapshot
is guaranteed to exist, predate the incident, or include preferences saved later.
Environment ciphertext is stored separately. No recovery on a real profile was
attempted or authorized by this investigation.
