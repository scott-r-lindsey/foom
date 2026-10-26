# Embedded native signing spike (#851)

The credential-free native macOS CI jobs run
`scripts/spike-remote-host-signing.mjs` on arm64 and x64. The script copies the
pinned node-pty assets, signs each with an ad-hoc hardened runtime signature,
generates a Node 24 SEA blob with those signed bytes, injects it with postject,
and signs the host with the production signing argument builder (ad-hoc identity).
It executes a `/bin/sh -f -c` PTY with a private fixture HOME and fixed PATH,
checks its output/exit, and strictly verifies both extracted native signatures.
No daemon, SSH, user shell startup files or network are involved.

It then re-signs the host with allow-jit only and records whether the ad-hoc
addon is accepted. Ad-hoc behavior is diagnostic, not a Developer ID enforcement
test. Real Developer ID start and
notarization remain a human post-merge check; this spike uses no credentials.
The script prints architecture, exact Node version and elapsed milliseconds.
The initial [CI run](https://github.com/scott-r-lindsey/foom/actions/runs/40247144442)
proved the positive path on both architectures: PTY output/exit and both extracted
signatures passed before the script reached its negative assertion. That assertion
incorrectly expected ad-hoc loading without the exception to fail; both runners
accepted it. The corrected spike records this observation and gates only the
positive assembly/loading/signature proof. This is a test-assumption correction,
not evidence of Developer ID validation or unsigned-swap rejection.

Initial complete spike step wall times (including that final failed assertion):
x64 29.6s with Node v24.19.0, arm64 11.1s with Node v24.20.0. The floating `.nvmrc`
selected different patches on different runner images. The implementation pins
an exact patch and rejects input/generator version differences. The shared production
assembler prints `assemblyMs` for each target; the corrected spike also prints
its total elapsed time and the observed ad-hoc behavior in CI logs.

The production path retains credential-free inputs (bundle, matching
Node executable, unsigned native assets, version/protocol/revision and hashes).
The main-only signer verifies these inputs, signs copies of both native assets
with its selected identity, regenerates/injects the SEA, and signs the result.
The blob disables code cache and snapshots to support assembly of both Darwin
architectures with the same Node version on the signing runner.

References: [Node SEA native addons and cross-platform blobs](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html),
[Apple library validation](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html).


Finished ad-hoc hosts remain separate catalog artifacts for non-macOS packaging;
macOS packaging and signing additionally download input artifacts from that same
run. This refines the issue's inputs-instead-of-binaries plan: Linux/Windows can
continue packaging all four targets without macOS tools, and the inputs stay out
of shipped application bundles. Release rebuilds only the nested hosts, preserving
the tested app's ASAR and fuse identity. Native extraction stays unchanged: the
filesystem race still exists, while Developer ID library validation enforces the
team boundary at load. Real Developer ID and notarization checks remain post-merge.


The first production-path run at `f0a58cf4` passed x64 assembly with Node 24.20.0:
23.6s for spike assembly, 27.9s complete spike, 17.8s production host assembly.
That initial pin selected an older macOS image's version and downgraded Windows
from the floating range's 24.22.1. Windows shard 2 then aborted twice in libuv's
`fs-event.c` short-path assertion. This is treated as a pin regression, not an
unrelated flake. The final pin is 24.22.1, the current
[Node 24 security release](https://nodejs.org/en/blog/release/v24.22.1), keeping
all input generators and the signer identical without that downgrade. No test
assertions, deadlines or shard configuration changed. Final CI must prove both
native Darwin architectures and packaging with this pin before review.
