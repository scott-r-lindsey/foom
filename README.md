# Foom

A small Electron hello world using strict TypeScript and Electron Forge. No UI framework or bundler is needed yet.

## Develop

Use Node.js 24 LTS (`nvm use`) and npm:

```sh
npm ci
npm start
```

Click **Say hello** to send a request through the preload bridge to the main process. Restart `npm start` after editing source files. Open Developer Tools using the standard Electron shortcut: Ctrl+Shift+I (Command+Option+I on macOS).

## How TypeScript fits into Electron

Electron runs the JavaScript generated from your TypeScript. `npm start`, `npm test`, `npm run package`, and `npm run make` compile automatically. Edit files in `src/`; `build/` is generated and ignored by Git. `npm run build` compiles without opening a window, and `npm run typecheck` checks types without writing output.

The **main process** (`main.ts`) runs with Node.js and manages the desktop window. The **renderer** (`renderer/renderer.ts`) runs the HTML interface with browser APIs. The **preload** (`preload.ts`) provides the small, explicitly allowed bridge between them. Its shared `DesktopApi` interface supplies autocomplete and compile-time checking on both sides. Runtime IPC validation remains necessary because TypeScript types disappear after compilation.

Main and preload compile to CommonJS, which works with Electron's sandboxed preload. Renderer code compiles as browser JavaScript, with Node globals excluded from its TypeScript environment. Forge configuration and build/test scripts remain JavaScript. TypeScript 6 is pinned for compatibility with the installed TypeScript ESLint tooling.

## Check and package

```sh
npm run typecheck
npm run lint
npm test
npm run package
npm run make
```

The integration test launches a real Electron window and verifies the greeting, isolated bridge, sandbox settings, asset restrictions, and popup blocking. Linux needs a graphical session or Xvfb (`xvfb-run -a npm test`), along with Electron's system libraries. Keep Chromium's sandbox enabled.

`package` produces an executable app in `out/`; `make` produces a ZIP in `out/make/` for the current OS and architecture. Build on each target OS. These are unsigned development artifacts. Configure your own app identifier, icons, platform installers, signing, and macOS notarization before public distribution.

## Structure

- `src/main.ts`: app lifecycle, windows, local asset protocol, and validated IPC handler.
- `src/preload.ts`: the single `window.desktop.sayHello()` capability.
- `src/renderer/`: HTML, CSS, and browser-only TypeScript UI code.
- `src/shared/desktop.ts`: the typed contract for the preload bridge.
- `scripts/build.mjs`: compile TypeScript and copy HTML/CSS into `build/`.
- `tsconfig.*.json`: separate main/preload and browser compiler environments.
- `forge.config.js`: packaging and production security fuses.
- `test/app.test.js`: real Electron integration smoke test.

## Security defaults

The renderer uses a sandbox, context isolation, and no Node integration. A strict Content Security Policy allows only local scripts and styles. The `app://` protocol serves an explicit asset allowlist. Navigation, new windows, webviews, and permission requests are blocked. IPC checks the sender's URL and main frame; the bridge never exposes raw Electron APIs. Production packages use ASAR and hardened Electron fuses.

Keep Electron updated and review the [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) when adding capabilities. Add a dedicated bridge method and main-process validation for each privileged operation.

### Dependency audit at scaffold time

`npm audit` reports 25 development-tooling advisories (3 low, 21 high, 1 critical) through the current stable Forge dependency tree, including archive extraction and temporary-file packages. The compatible `npm audit fix` does not resolve them; its forced alternative proposes a Forge downgrade. These remain outstanding. Recheck upstream updates before release and only use trusted build inputs. `npm audit --omit=dev` reports zero advisories; this does not audit Electron's bundled Chromium or Node.js runtime.
