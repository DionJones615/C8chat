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
- **Themes and settings** — Default (big heads, with the drawn speech balloon
  in the game art's palette), Classic, Paper, and Terminal (amber); text/head
  sizes, timestamp format, and visibility switches.
- **Debug capture** — a local frame viewer/exporter for protocol work.

The extension does **not** implement inventory, stash, postcards, macros, or
automation. The manifest does not claim them.

## Install

C8 Chat is distributed through GitHub Releases. Download the asset for your
browser family from the [latest release](https://github.com/DionJones615/C8chat/releases/latest).

| Browser family | Download | Install |
| --- | --- | --- |
| **Chromium-based** (Chrome, Chromium, Edge, Brave, …) | [`c8-chat-chrome.zip`](https://github.com/DionJones615/C8chat/releases/latest/download/c8-chat-chrome.zip) | Extract it, open the browser’s extensions page (for example `chrome://extensions`), enable **Developer mode**, and **Load unpacked** the folder containing `manifest.json`. |
| **Firefox-based** (Firefox, LibreWolf, Waterfox, …) | [`c8-chat-firefox-signed.xpi`](https://github.com/DionJones615/C8chat/releases/latest/download/c8-chat-firefox-signed.xpi) | Open `about:addons`, click the gear button, and choose **Install Add-on From File**. |
| **All assets** | [`releases/latest`](https://github.com/DionJones615/C8chat/releases/latest) | Chromium ZIP, Firefox signed/unsigned XPI, source ZIP, and `SHA256SUMS`. |

Chromium-based browsers do not auto-update unpacked extensions: replace the
folder contents with the new release and click **Reload**. Chrome 137 removed
the `--load-extension` command-line flag from branded Chrome builds; the
extensions-page UI is the supported path.

Firefox-based browsers install the **signed** XPI and update through the
extension’s `update_url`. The unsigned XPI is for development, or for forks that
explicitly allow unsigned add-ons; stock Firefox requires the signed build.
GitHub may serve the XPI as a download rather than an install prompt — save it,
then use **Install Add-on From File**.

Detailed steps and checksum verification are in [docs/INSTALL.md](docs/INSTALL.md).

### Development builds

For Chromium development, run `npm run package:unpacked`, then Load unpacked
`dist/chromium-unpacked`. For Firefox development, open
`about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and
select `manifest.json`.

## Privacy

C8 Chat works locally. It stores the chat scrollback, settings, recent
recipients, the last room, and small diagnostic samples in
`chrome.storage.local`. It does not send data to the developer or any third
party, does not include analytics or ads, and does not load remote code. Private
browsing is disabled for the extension. The toolbar handler uses the browser’s
tabs API only to find an existing Castle Infinity tab to focus, or to open one.

The full policy is [PRIVACY.md](PRIVACY.md) and is published at
<https://dionjones615.github.io/C8chat-privacy/>.

## How it works

The game is an Emscripten/WASM build whose sockets are tunnelled through a plain
browser `WebSocket`. The extension has two content scripts and a background
toolbar handler:

| Piece | Scope | Role |
| --- | --- | --- |
| `src/protocol.js` | MAIN | Wire codec and message decoders |
| `src/agent.js` | MAIN | Taps the page's WebSocket and input hooks |
| `src/panel.js` | ISOLATED | Chat UI, settings, storage, and feature logic |
| `src/background.js` | Background | Focuses an open game tab or opens one from the toolbar |

The two content-script worlds talk only over `window.postMessage`; the account
key is redacted at the agent boundary. The docked layout asks the game's own
`#stage` to reserve space and lets the page re-fit its canvas; the canvas itself
is not touched.

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
- `npm run package` — builds the Chromium ZIP, Firefox unsigned XPI, source ZIP,
  stable aliases, and `SHA256SUMS` in `dist/`.
- `npm run smoke` — headless Chromium smoke test (requires Chromium; see
  [AGENTS.md](AGENTS.md)).

There is no build step. `scripts/package.mjs` validates the manifest and zips the
files; it does not transform source. See [README-BUILD.md](README-BUILD.md) for
the reviewer-facing reproduction instructions.

## Releasing

1. Bump the version in `manifest.json` and `package.json`, and update
   [CHANGELOG.md](CHANGELOG.md).
2. Update [docs/updates.json](docs/updates.json) with
   `node scripts/updates.mjs`, then run `npm ci && npm run check`.
3. Commit, tag `v<version>`, and push the tag. The release workflow verifies the
   version and creates a GitHub Release with the Chromium ZIP, Firefox unsigned
   XPI, source ZIP, stable aliases, and checksums.
4. Run the manual **Sign Firefox (AMO unlisted)** workflow to sign the Firefox
   package and upload the signed XPI. See [DISTRIBUTING.md](DISTRIBUTING.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports should follow
[SECURITY.md](SECURITY.md), not a public issue.

## License

The extension code is [MIT licensed](LICENSE). Castle Infinity and its artwork
belong to their respective rights holders. The speech balloons are drawn in CSS
rather than shipped, and schtick head art is read from the running game at
runtime. The one image that is included is the small radio starburst used to mark
private messages, kept because it is the mark that tells a PM apart from room
talk; remove that rule in `src/panel.css` if you need a build without it.

## Contact

dion.jones@gmail.com
