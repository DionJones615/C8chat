# Reviewer notes — C8 Chat

These notes apply to both the Chrome Web Store and Firefox AMO reviews.

## What the extension is

C8 Chat is an unofficial chat and room panel for
https://www.castleinfinity.com/. It injects a panel, reads the game's own
WebSocket traffic to build the chat/room view, and drives the game's existing
input API for the compose box. It runs only on that origin.

## Test script

1. Open https://www.castleinfinity.com/ and wait for the game to finish loading.
2. The C8 Chat panel opens floating. If it is hidden, click the gold infinity
   button in the game's top-right button row.
3. The header shows the build version; the launcher toggles the panel.
4. Open Settings (the cog). The Panel row offers Floating, Dock left, and Dock
   right. Try each; the game stage should reflow to make room, and the panel
   should remember the choice.
5. Open the recipient list in the compose row. It should show the room option and
   online players, with a room name and `(here)` where applicable.
6. Type a short room message and send it. Public speech goes through the game's
   own input path; a private message uses the game's own `0x19` frame.
7. Optional: Settings → Debug opens the local frame capture/export pane.

No account credentials are supplied. The game creates a guest account on first
login and does not ask for an email or password.

## Technical notes

- **Two content scripts.** `src/protocol.js` and `src/agent.js` run in the MAIN
  world at `document_start`; `src/panel.js` runs in the isolated world at
  `document_idle`. The two halves talk only over `window.postMessage`, with the
  origin and source checked.
- **WebSocket tee.** The agent wraps the page's own `WebSocket` constructor and
  `send`, preserving `instanceof` and the original behaviour. It observes frames
  already sent/received; it does not redirect, proxy, or create a second socket.
- **Private messages.** The panel synthesizes the game's own `0x19` frame,
  byte-for-byte the shape the client emits from StellaVision, and sends it on the
  page's existing socket only when the user sends a message. Public speech and
  key input go through the game's exported input API.
- **Account key.** The agent reads the game session key in memory only to redact
  it from anything forwarded or stored. The key never reaches storage or the UI.
- **Docked layout.** When docked, the panel reserves width on the game's `#stage`
  and shifts the login overlay/status/key cluster and the `?`/players buttons so
  the panel does not cover them. The game's own layout function re-fits the
  canvas; the canvas and game logic are not modified.
- **No remote code.** All scripts and styles are packaged. There is no `eval`,
  `new Function`, `importScripts`, CDN, or remote stylesheet.
- **No build step.** The source is hand-written ES5/ES modules for tests; there
  is no minifier, bundler, or transpiler. `README-BUILD.md` explains the
  `scripts/package.mjs` archive step.
- **Art.** The package does not redistribute the game's balloon art. The Default
  theme uses a plain CSS bubble. Schtick head art is read from the running game's
  own package at runtime and displayed from a canvas.
- **Data.** The chat log, settings, recent recipients, last room, and small
  diagnostic samples stay in `chrome.storage.local`. Nothing is sent to the
  developer or a third party. Private browsing is disabled with
  `"incognito": "not_allowed"`.

## Known limitations

Inventory, stash, postcards, macros, and automation are not implemented. The
listing and manifest do not claim them. The Debug pane is a local protocol tool,
not a gameplay feature.

## Contact

dion.jones@gmail.com
