## Opening an unsigned nightly

Download the ZIP for your platform and extract it. These are development builds,
not signed or notarized releases. The release's `SHA256SUMS` covers all three ZIPs.

- **macOS (Apple silicon / arm64):** a browser download may be reported as
  “damaged” by Gatekeeper. After extracting, run
  `xattr -dr com.apple.quarantine Foom.app` in the folder containing the app,
  then open Foom.app. The bundle has an ad-hoc signature verified in CI.
- **Windows (x64):** open `foom.exe`. If SmartScreen warns, choose **More info →
  Run anyway**.
- **Linux (x64):** extract and run `./foom` in a graphical desktop session.
  On Ubuntu 24.04, install Electron's runtime libraries with
  `sudo apt install libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 libatk-bridge2.0-0t64`.
  Chromium requires a working user-namespace sandbox; do not disable the sandbox.

The application menu's About panel reports the nightly version. The bundled
console helper reports it with `foom --version` once installed on PATH through
Foom's `--install-cli` command; see [console usage](https://github.com/scott-r-lindsey/foom/blob/main/docs/orchestration.md#console-helper-and-local-pairing-154).
