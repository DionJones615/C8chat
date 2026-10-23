# Firefox AMO listing — C8 Chat

## Item details

- **Name:** C8 Chat
- **Add-on URL:** `c8-chat` if available, otherwise a close variant.
- **Summary (≤250):** Unofficial chat panel for Castle Infinity: room transcript, schtick heads, who is here, private messages, docked or floating.
- **Categories:** Social & Communication; Games & Entertainment (optional second).
- **Support email:** dion.jones@gmail.com
- **Support website:** https://github.com/DionJones615/C8chat
- **License:** MIT
- **Privacy policy:** check the box and use
  https://dionjones615.github.io/C8chat-privacy/
- **Experimental:** No
- **Requires payment:** No

## Description

C8 Chat is an unofficial chat and room panel for Castle Infinity. It adds an
IRC-style transcript beside the game, with the speaker's schtick head, a room
roster, private messages, and a panel you can dock left, dock right, or leave
floating.

- Chat transcript with timestamps, per-speaker colours, schtick heads read from
  the running game, and a 300-line local scrollback.
- Room presence: the roster you arrive to, then joins, leaves, room changes,
  disconnects, and reconnects read from the game's own traffic.
- Private messages with a recipient list, a (PM) mark, and a (here) marker for
  players in your sector.
- Dock left, dock right, or float; placement, dock width, and floating geometry
  are remembered.
- Default, Classic, Paper, and Terminal themes; text and head sizes; timestamp
  format; visibility switches.
- A local Debug pane for protocol work and frame capture.

Requirements: Firefox 142 or newer. The extension runs only on
https://www.castleinfinity.com/*.

Privacy: C8 Chat stores the chat scrollback, settings, recent recipients, the
last room, and small diagnostic samples locally in the browser. It does not send
data to the developer or any third party, does not include analytics or ads, and
does not load remote code. Private browsing is disabled for the extension.

C8 Chat is not affiliated with Castle Infinity, its preservation project, or any
rights holder. It is a fan-made companion tool. Inventory, stash, postcards,
macros, and automation are not implemented and are not claimed.

## Source code

Answer **No**. The package is hand-written ES5 with no minifier, bundler,
transpiler, or generated code. `README-BUILD.md` and
`dist/c8-chat-<version>-source.zip` are available if a reviewer asks; the source
archive is the same code plus tests and documentation.

## Data collection

The manifest declares:

```json
"data_collection_permissions": {
  "required": ["none"]
}
```

No data is transmitted to the developer or a third party. The chat log,
settings, recent recipients, last room, and diagnostic samples stay in
`chrome.storage.local`. The only outbound traffic is the game's own WebSocket,
which the user directs, and a same-site `GET /api/players` made with
`credentials: "omit"`.

If AMO challenges the synthesized private-message frame, change the required
list to `["personalCommunications"]`, update `PRIVACY.md` and this listing, and
re-submit.

## Notes for reviewers

See `store/reviewer-notes.md` for the full test script and technical notes. In
short:

- No credentials are needed. The game creates a guest account on first login.
- Open the game and wait for it to load. The panel opens floating; if it is
  hidden, click the gold infinity button, then open Settings → Panel to try the
  three placements.
- The MAIN-world content script wraps the page's own `WebSocket` to observe
  traffic; it does not redirect or proxy it.
- The panel sends the game's own `0x19` private-message frame only when the user
  sends one.
- The game's session key is read in memory only to redact it from diagnostics.
- Docked mode adjusts the game's own `#stage` and overlay elements to reserve
  room; the canvas and game logic are not touched.
- No remote code is loaded. The extension only runs on the game origin.
- Inventory, stash, postcards, macros, and automation are not implemented.
