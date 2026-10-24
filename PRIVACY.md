# C8 Chat Privacy Policy

**Effective date:** 2026-10-24

C8 Chat is an unofficial browser extension that adds a chat and room panel to
<https://www.castleinfinity.com>. It is not affiliated with Castle Infinity, its
preservation project, or any rights holder.

This policy explains what C8 Chat accesses, what it stores, and what it does
**not** do. C8 Chat is designed to work locally: it does not send data to the
developer or to any third party.

## Contact

Questions or requests: **dion.jones@gmail.com**

## What C8 Chat accesses

While the game is open, C8 Chat accesses:

- The game page's own DOM and styles, so it can add the panel and, when docked,
  make room for it by adjusting the game's stage and overlay elements.
- The game's own WebSocket traffic, read in place so the panel can show room
  chat, speaker names, room membership, joins and leaves, and private messages.
  C8 Chat does not redirect or proxy that socket.
- `https://www.castleinfinity.com/api/players`, a same-site GET request made with
  `credentials: "omit"` to fill the recipient list. It sends no account cookies.
- The game's session key, read **in memory only** so it can be removed from
  diagnostic data. The key is never written to storage, never displayed, and
  never transmitted.
- The browser's tabs API, only to focus an already-open Castle Infinity tab or
  open a new one when you click the toolbar icon. It does not read page content
  from other sites.

## What C8 Chat stores locally

C8 Chat stores the following in `chrome.storage.local` in your browser:

- The chat scrollback, capped at 300 lines, including message text, speaker
  names, timestamps, room names, and private-message markers.
- Settings: panel placement (floating, dock left, dock right), dock width,
  floating position and size, theme, text size, head size, timestamp format, and
  visibility switches for heads, names, colours, system lines, and presence.
- Recent private-message recipients and the last room you were in.
- Diagnostic data written by the panel: a boot/build marker, frame and actor
  counts, a short last-line sample, errors, the current game URL, and small
  base64 samples of game frames. These samples may contain chat text, player
  names, or room data. They are local-only and are overwritten as the panel runs.
- Debug capture is kept in memory until you explicitly export it. An export is a
  local file you choose to save.

Private browsing is disabled for this extension (`"incognito": "not_allowed"`),
so data from private windows is not written to the shared extension store.

## What C8 Chat does not do

C8 Chat does **not**:

- Send your chat log, settings, player names, game URL, or diagnostic samples to
  the developer or to any third party.
- Include analytics, telemetry, advertising, tracking pixels, or affiliate code.
- Load or execute remote code. All scripts and styles are packaged with the
  extension.
- Read cookies, passwords, email, browsing history, or data from other websites.
  It runs only on `https://www.castleinfinity.com/*`.
- Store the game session key.
- Run in private/incognito windows.

## Sending messages and private messages

When you send room speech or a private message, the text goes to the game through
the game's own existing WebSocket. That is the same destination the game itself
uses. C8 Chat does not add a developer server or any other recipient.

## Third parties

C8 Chat has no server and no third-party data recipients. The Castle Infinity
game service is operated separately; its own privacy practices apply to the game
and to messages you send through it.

## Retention and deletion

- The scrollback is capped at 300 lines and older lines are dropped.
- Diagnostic data is overwritten while the panel runs.
- Settings and the scrollback remain until you remove the extension or clear its
  extension data in your browser.
- Uninstalling C8 Chat removes its local storage. There is no server-side account
  or backup to delete.

## Children

C8 Chat is a companion tool for a game intended for nostalgic adult players. It
does not knowingly collect personal information from children and has no server
to receive it.

## Security

C8 Chat keeps data in the browser's extension storage, loads only packaged code,
and uses the game's existing HTTPS/WSS connection. The account key is redacted in
memory before any diagnostic data is stored. No method is perfectly secure; keep
your browser and the game client up to date.

## Limited Use

C8 Chat's use of user data is limited to providing its single purpose: the chat
and room panel for Castle Infinity. C8 Chat does not sell or transfer user data,
does not use it for advertising or creditworthiness purposes, and does not allow
humans to read it. Data stays in the browser unless you explicitly export a debug
capture or send a message through the game.

## Changes

Material changes to this policy will be published in the repository and linked
from the project release pages. The effective date at the top will be updated.

## Contact

**dion.jones@gmail.com**
