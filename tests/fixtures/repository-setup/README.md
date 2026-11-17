# Historical setup approval

`catalog-v1-approval.json` was produced by the actual `parseSetupList` and catalog
from commit `dfaff84b8cdd6f0451ee2f6b58f32470550ecd6d`. Its canonical list and catalog
digests are fixed. It contains the formerly accepted Debian operands `g++` and
`libfoo1.2` so tests verify read-only compatibility without accepting them in new
approvals or executable plans. Do not regenerate it with the current parser.

Electron restart tests retain their fixture registration identity and source
snapshot while replacing only the list, list digest, catalog and revision with
these historical values. All profile paths and processes are test-owned.
