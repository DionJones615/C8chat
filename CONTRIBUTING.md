# Contributing to C8 Chat

C8 Chat is an unofficial chat panel for the Castle Infinity browser game. It is a
dependency-free Manifest V3 extension: the files in `manifest.json`, `src/`, and
`icons/` are the extension, and there is no build step.

## Before you start

- Use Node.js 22 or newer.
- Read the [README](README.md), [PRIVACY.md](PRIVACY.md), and
  [AGENTS.md](AGENTS.md). `AGENTS.md` is the maintainer's guide to installing and
  verifying the extension in Firefox-based and Chromium-based browsers.
- Do not add game artwork beyond the one documented private-message radio sprite.
  Schtick heads are read from the running game at runtime.
- Do not add remote code, `eval`, `new Function`, `importScripts`, analytics, or a
  second runtime dependency without prior agreement.
- Do not commit AMO credentials, private API keys, personal data, or screenshots
  that show real players without permission.

## Setup

```sh
npm ci
npm run check
```

`npm run check` packages the unpacked extension, runs the AMO linter
(`addons-linter`), runs the
Node test suite, and builds the release archives. The individual commands are:

```sh
npm test              # node --test test/*.test.mjs
npm run lint          # web-ext lint on dist/unpacked
npm run package       # dist archives + SHA256SUMS
npm run smoke         # headless Chromium smoke test, if Chromium is available
```

The packaging test builds into a temporary directory, so it does not depend on a
previous `npm run package`.

## Code style

- `src/*.js` runs as browser content scripts. Keep it in the existing ES5 style:
  `var`, function declarations, no modules, no transpiler.
- `scripts/*.mjs` and `test/*.mjs` are Node ESM and may use modern syntax.
- Match the surrounding formatting; do not reformat unrelated code.
- Keep the manifest permissions minimal. The extension only needs `storage` and
  `https://www.castleinfinity.com/*`.
- Preserve the no-build-step property. `scripts/package.mjs` may validate and zip
  files, but it must not transform source code.
- Add or update tests for behaviour changes. Tests should use the existing
  deterministic stubs rather than a live game.

## Browser checks

Use the procedures in [AGENTS.md](AGENTS.md). In short:

- Chromium: stage `dist/chromium-unpacked` where the browser can read it, load it unpacked,
  and verify `#c8-chat-host` → shadow root `#panel`. The headless Chromium/CDP
  procedure does not need Selenium or Playwright.
- Firefox: use the `browser-extensions` distrobox with geckodriver and Selenium,
  or a temporary add-on in a throwaway profile.
- Do not restart or edit a maintainer's daily browser profile. Do not leave a
  browser running after a check. State exactly which check ran.

## Pull requests

1. Fork or branch from `main`; use a descriptive branch name.
2. Keep the change focused and update `CHANGELOG.md` under `[Unreleased]`.
3. Run `npm ci && npm run check` and the relevant browser check.
4. Open a pull request using the template. CI must pass.
5. Do not force-push a shared branch. Do not merge with failing checks.

By submitting a contribution, you agree to license it under the repository's
[MIT License](LICENSE).

## Releases

1. Update the version in `manifest.json` and `package.json` together.
2. Move the changelog entries from `[Unreleased]` into the new version section.
3. Run `npm ci && npm run check`.
4. Update `docs/updates.json` with `node scripts/updates.mjs`, then run
   `npm ci && npm run check`.
5. Commit, tag `v<version>`, and push the tag. The release workflow verifies the
   versions, builds the Chromium ZIP, Firefox unsigned XPI, source ZIP, stable
   aliases, and `SHA256SUMS`, and creates the GitHub Release.
6. Run the **Sign Firefox (AMO unlisted)** workflow to upload the signed XPI. See
   [DISTRIBUTING.md](DISTRIBUTING.md).

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Community

All participants are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
