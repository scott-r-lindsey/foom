# Embedded native signing spike (#851)

The credential-free native macOS CI jobs run
`scripts/spike-remote-host-signing.mjs` on arm64 and x64. The script copies the
pinned node-pty assets, signs each with an ad-hoc hardened runtime signature,
generates a Node 24 SEA blob with those signed bytes, injects it with postject,
and signs the host with the production signing argument builder (ad-hoc identity).
It executes a `/bin/sh -f -c` PTY with a private fixture HOME and fixed PATH,
checks its output/exit, and strictly verifies both extracted native signatures.
No daemon, SSH, user shell startup files or network are involved.

It then re-signs the host with allow-jit only and requires addon loading to fail.
Ad-hoc signatures have no Team ID, so this rejection is expected and does not
show that Developer ID assembly is infeasible. Real Developer ID start and
notarization remain a human post-merge check; this spike uses no credentials.
The script prints architecture, exact Node version and elapsed milliseconds.
CI results and timings will be recorded here before choosing an implementation.

The proposed production path retains credential-free inputs (bundle, matching
Node executable, unsigned native assets, version/protocol/revision and hashes).
The main-only signer verifies these inputs, signs copies of both native assets
with its selected identity, regenerates/injects the SEA, and signs the result.
The blob disables code cache and snapshots to support assembly of both Darwin
architectures with the same Node version on the signing runner.

References: [Node SEA native addons and cross-platform blobs](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html),
[Apple library validation](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html).
