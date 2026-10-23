# Chrome Web Store listing — C8 Chat

## Item details

- **Name:** C8 Chat
- **Short description:** Unofficial chat panel for Castle Infinity: room transcript, schtick heads, who is here, private messages, docked or floating.
- **Category:** Social & Communication
- **Language:** English (United States)
- **Store icon:** `store/assets/icon-128.png`
- **Small promo tile:** `store/assets/promo-440x280.png`
- **Screenshots:** 3–5 at 1280×800 in `store/assets/`
- **Privacy policy:** https://dionjones615.github.io/C8chat-privacy/
- **Support:** dion.jones@gmail.com

## Detailed description

C8 Chat is an unofficial chat and room panel for Castle Infinity. It adds an
IRC-style transcript beside the game, with the speaker's schtick head, a room
roster, private messages, and a panel you can dock left, dock right, or leave
floating.

Features:

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

Requirements: Chrome/Chromium 121 or newer. The extension runs only on
https://www.castleinfinity.com/*.

Privacy: C8 Chat stores the chat scrollback, settings, recent recipients, the
last room, and small diagnostic samples locally in the browser. It does not send
data to the developer or any third party, does not include analytics or ads, and
does not load remote code. Private browsing is disabled for the extension.

C8 Chat is not affiliated with Castle Infinity, its preservation project, or any
rights holder. It is a fan-made companion tool. Inventory, stash, postcards,
macros, and automation are not implemented and are not claimed.

## Privacy practices

### Single purpose

An unofficial chat and room panel for the Castle Infinity browser game.

### Permission justifications

- **storage:** Stores the user's chat scrollback (last 300 lines), panel
  placement and size, theme and display settings, recent private-message
  recipients, the last room, and small diagnostic samples. All local; nothing is
  synced or transmitted.
- **https://www.castleinfinity.com/*:** The extension runs only on the game page.
  It needs the page's own WebSocket traffic to build the chat transcript and
  room/player list, the page's DOM to inject the panel and make room when docked,
  and the game's existing input API for the compose box.

### Remote code

No, I am not using remote code.

### Data usage

Select:

- Personally identifying information — player/user names appear in the local
  chat log.
- Personal communications — room chat and private-message text are stored
  locally.
- Website content — the game page and its WebSocket data are read to build the
  panel.

Explain in the privacy policy that all processing is local. Do not select health,
financial, location, or web history. Complete the Limited Use certification.

### Test instructions

1. Open https://www.castleinfinity.com/ and wait for the game to load.
2. The C8 Chat panel opens floating. If it is hidden, click the gold infinity
   button in the game's top-right button row.
3. Open Settings (the cog) and use the Panel row to try Floating, Dock left, and
   Dock right.
4. Open the recipient list in the compose row; it should show the room option and
   online players.
5. No credentials are supplied. The game creates a guest account on first login.

## Distribution

- Visibility: Public
- Regions: All regions
- Pricing: Free
- Trader/Non-Trader: complete the declaration (Non-Trader is usual for a free,
  non-commercial hobby extension; this is the publisher's determination).
