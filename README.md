# C8 Chat

[![CI](https://github.com/DionJones615/C8chat/actions/workflows/ci.yml/badge.svg)](https://github.com/DionJones615/C8chat/actions/workflows/ci.yml)
[![Release](https://github.com/DionJones615/C8chat/actions/workflows/release.yml/badge.svg)](https://github.com/DionJones615/C8chat/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An unofficial chat and room panel for [Castle Infinity](https://www.castleinfinity.com/).
It adds an IRC-style transcript with schtick heads, a room roster, private
messages, and a panel you can dock left, dock right, or leave floating.

C8 Chat is a dependency-free Manifest V3 extension. It has no build step, no
runtime dependencies, and no server. It runs only on
`https://www.castleinfinity.com/*`.

> C8 Chat is not affiliated with Castle Infinity, its preservation project, or
> any rights holder. It is a fan-made companion tool.

## Features

- **Chat transcript** — timestamps, per-speaker colours, schtick heads from the
  running game, and a 300-line local scrollback.
- **Room presence** — the roster you arrive to, then joins, leaves, room changes,
  disconnects, and reconnects read from the game's own traffic.
- **Private messages** — send to a player from the recipient list, with `(PM)`
  marking and a `(here)` marker for players in your sector.
- **Dock or float** — dock left, dock right, or float; placement, dock width,
  and floating geometry persist.
- **Themes and settings** — Default (big heads), Classic, Paper, and Terminal
  (amber); text/head sizes, timestamp format, and visibility switches.
- **Debug capture** — a local frame viewer/exporter for protocol work.

The extension does **not** implement inventory, stash, postcards, macros, or
automation. The manifest and store copy do not claim them.

## Install

### Chrome / Edge / Brave

Requires Chrome/Chromium 121+. For development:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `dist/unpacked`
   directory (run `npm run package:unpacked` first).
3. Open the game and reload the tab.

The store listing will be linked here once published.

### Firefox / Zen

Requires Firefox 142+. For development, open
`about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and
select `manifest.json`. For Zen's Flatpak sandbox and the unsigned-local-add-on
procedure, see [AGENTS.md](AGENTS.md).

The AMO listing will be linked here once published.

## Privacy

C8 Chat works locally. It stores the chat scrollback, settings, recent
recipients, the last room, and small diagnostic samples in
`chrome.storage.local`. It does not send data to the developer or any third
party, does not include analytics or ads, and does not load remote code. Private
browsing is disabled for the extension.

The full policy is [PRIVACY.md](PRIVACY.md) and is published at
<https://dionjones615.github.io/C8chat-privacy/> once the privacy site is live.

## How it works

The game is an Emscripten/WASM build whose sockets are tunnelled through a plain
browser `WebSocket`. The extension has two content scripts:

| Piece | World | Role |
| --- | --- | --- |
| `src/protocol.js` | MAIN | Wire codec and message decoders |
| `src/agent.js` | MAIN | Taps the page's WebSocket and input hooks |
| `src/panel.js` | ISOLATED | Chat UI, settings, storage, and feature logic |

The two worlds talk only over `window.postMessage`; the account key is redacted
at the agent boundary. The docked layout asks the game's own `#stage` to reserve
space and lets the page re-fit its canvas; the canvas itself is not touched.

The detailed protocol map, feature notes, and protocol limitations are in
[docs/protocol.md](docs/protocol.md). Test-harness details are in
[docs/testing.md](docs/testing.md).

## Development

Requirements: Node.js 22+ and npm.

```sh
npm ci
npm run check
```

- `npm test` — Node test suite (`test/*.test.mjs`).
- `npm run lint` — packages `dist/unpacked`, then runs `web-ext lint`.
- `npm run package` — builds the Chrome ZIP, Firefox XPI, source ZIP, and
  `SHA256SUMS` in `dist/`.
- `npm run smoke` — headless Chromium smoke test (requires Chromium; see
  [AGENTS.md](AGENTS.md)).

There is no build step. `scripts/package.mjs` validates the manifest and zips the
files; it does not transform source. See [README-BUILD.md](README-BUILD.md) for
the reviewer-facing reproduction instructions.

## Releasing

1. Bump the version in `manifest.json` and `package.json`, and update
   [CHANGELOG.md](CHANGELOG.md).
2. Run `npm ci && npm run check`.
3. Commit, tag `v<version>`, and push the tag. The release workflow verifies the
   version and creates a GitHub Release with the Chrome ZIP, Firefox XPI, source
   ZIP, and checksums.
4. Store publishing is a separate manual, environment-gated workflow. See
   [PUBLISHING.md](PUBLISHING.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports should follow
[SECURITY.md](SECURITY.md), not a public issue.

## License

The extension code is [MIT licensed](LICENSE). Castle Infinity and its artwork
belong to their respective rights holders; no game artwork is included in this
repository or the packaged extension. Schtick head art is read from the running
game at runtime.

## Contact

dion.jones@gmail.com
