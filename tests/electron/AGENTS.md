# Electron tests

Read [fixtures](../../docs/electron-fixtures.md),
[sharding](../../docs/electron-shards.md) and
[validation](../../docs/validation.md) before changing this area.

- Electron tests use an isolated profile and fixture repositories per test. Register cleanup before launching; quit all apps before deleting fixtures, including on assertion or startup failure. The process audit tracks app descendants and fails on surviving processes; never use retries to hide leaks.
- Wait for visible UI, bridge state, terminal output or quit acknowledgement before the next interaction. Use `tests/electron/test-policy.js` for platform-scaled deadlines, not individual timeout increases. Keep fixed delays only when elapsed time is the behavior under test. A test must also pass alone with `--test-name-pattern`.
