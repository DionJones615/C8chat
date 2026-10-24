# C8 Chat — technical notes

## How it works

The game is an Emscripten WASM build whose BSD sockets are tunnelled through a
plain browser `WebSocket` (`wss://baron.castleinfinity.com:443/?target=<port>`),
and whose only JS-facing hooks are a handful of `Module._c8_*` exports plus a
`window.c8SetControlState` callback. All of that lives in the page's own JS
context, so the extension is split in two:

| Piece | World | Role |
| --- | --- | --- |
| `src/protocol.js` | MAIN | Wire codec: `[len][0x71][channel][opcode][payload]`, plus the message encoders/decoders |
| `src/agent.js` | MAIN | Taps the WebSocket and `c8SetControlState`; exposes key/text injection, message send, and the page's own canvas-layout hook |
| `src/panel.js` | isolated | The chat pane, the settings sheet, storage and feature logic |

The two halves talk only over `window.postMessage`. Firefox sets `event.source` to
`null` for extension-script messages, so both bridge listeners accept a null source
only when the event origin matches the page; non-null sources must still match the
page window. The account key is scrubbed at the agent boundary, so it never reaches
storage or the UI.

## The protocol

Everything below was pinned down by capturing live traffic and diffing the frames
either side of one in-game action. Channel `0x01` is the sector server (SIP),
`0x08` is the metaserver (ILP).

| Op | Dir | Meaning | Layout |
| --- | --- | --- | --- |
| `0x01` | out | **room login** | `[…][name pstr][room: u16][key]` on SIP, sent on arriving in a room; `[16B name][16B key]` on ILP when entering the game |
| `0x02` | in | **actor appears** | actor descriptor carrying an `_actorName` record and the schtick parts |
| `0x03` | in | server assignment | port + 32-byte hex session token |
| `0x04` | in | greeting **or** actor name record | on ILP `… [len]"Phase 2 dev metaserver"`; on SIP the `_actorName` shape, sent as somebody appears |
| `0x05` | in | **actor left** | `[actor key: u32]` — the counterpart of `0x04`, and nothing else |
| `0x0b` | both | keepalive | 4-byte nonce, echoed verbatim |
| `0x14` | in | sector list | repeated `{4-char code, u32}` |
| `0x17` | out | sector range request | `[from: 4B][to: 4B]`, answered by a `0x14` list |
| `0x19` | out | **send message** | `[to: 32B][text]` |
| `0x1a` | in | **receive message** | `[from: 32B][12B meta][text]` |
| `0x1e` | out | player search | `[name: 32B]` |
| `0x1f` | in | player info | `[name: 32B][tag: 1B][sector: u16]…` |

`0x19` and `0x1a` are the StellaVision message pair; sending to yourself returns
your own message with the name canonicalised, which is how the receive layout was
confirmed. `0x1e`/`0x1f` come from the **Search** screen and independently agree
with `/api/players`.

## Features

- **Room presence** — the log says who is in the room with you, and when that
  changes: the roster you arrive to is one line (`IN ROOM: Ann, Bob`), then
  `JOINED: Ann` and `LEFT: Ann` as they come and go. A `LEFT` line is **committed when
  it is written** — it says what the panel knew at that moment and nothing later may
  rewrite it, not a returning player, not the id being reused, not the name map being
  cleared. (An arrival is the exception: `JOINED: someone` is renamed once the record
  that names them lands, because that line is still open.) A departure is announced only
  when the panel can attribute it — named, or at least seen moving about this room.
  The server repeats some frames, and the second copy of a leave arrives after the
  first consumed the name; an id left over from a room we just left is nobody's
  either. Both are dropped rather than printed as `LEFT: someone`. An arrival the wire has not
  named yet reads `JOINED: someone` rather than its actor tag — a tag is an opaque
  room-local id, and half of them are control characters, so announcing one looks
  like a player called `NRBr`; the line is renamed the moment a record lands. Tags
  stay on *speech*, where they honestly mark an unnamed voice and keep two of them
  apart. It is **room membership read
  off the wire** (`0x04`/`0x05`, and the entry snapshot), not a distance. This used
  to be called *earshot*, which overclaimed: the game never tells us how far away
  anybody is, so a player across a large room reads exactly like one standing next
  to you. What the balloon actually reaches is a separate question, and the only
  thing we can say about it is which sector a player is in — the recipient list
  shows that room beside each name, and marks `(here)` on the ones sharing yours.
  **StellaCenter (sector 78) is exempt, and the panel says nothing about it.** The hub
  is the room you are always passing through, so a line per event means two lines
  every trip for a room you were only transiting, on top of a door that never stops
  moving. Both are silent there: the `ENTERING`/`LEAVING` pair and the presence of
  everybody walking past. The roster line on arrival still is — who is here is worth
  knowing, who walked past on their way somewhere else is not — and the room is still
  tracked: the `(here)` marks, the room name in the recipient list, the names and the
  faces. A `RECONNECTED` line is not a transition and still appears. No other room is
  affected, and the settings switch still hides presence everywhere.
- **TEAM-room guard** — the room type is not on the wire; it is in `connect.dat`.
  A room is TEAM when a `TEAM` record reaches it and no ordinary record does —
  its only entrance is a TEAM (nozzlebox) entrance. In a TEAM room the log and the
  compose row are replaced by "This might be a little cheaty in this room" and a
  **That's OK** button; the transcript keeps filling behind the notice, and OK
  reveals it until the room changes. A map that cannot be read leaves the chat
  visible. (See "Room changes" for the full rule.)
- **Chat** — the panel itself, IRC style. The scrollback is stored as plain data:
  entries hold `_msg`, the live DOM node a line is grown through, and
  `chrome.storage` refuses to clone a node — which rejected the whole set and made
  every save fail silently, leaving the log frozen at whatever an earlier build had
  written. `storable()` strips the private fields, and a test asserts no stored
  field is ever an object. Text is selectable: the game sets
  `user-select: none` on `html`/`body`, which `:host{all:initial}` would inherit,
  so the panel opts back in. Then:
  `HH:MM Nick text`, per-nick colours hashed the way IRC clients do, and uppercase
  system lines for searches and room moves. It has an input line, keeps a
  scrollback, and persists it across reloads. Every row also carries the full
  `HH:MM:SS` it started at (and the time it settled) as its `title`, so the time is
  one hover away even when the visible stamp is switched off.
- **Chat log look** — in Settings: the timestamp format (`Default` — whatever the
  browser does, `24-hour`, `24-hour + seconds`, `12-hour`, or `Hidden`), the log
  text size (11–16 px), the head size (theme default, or 18–44 px), and switches for
  what a line shows — schtick heads, usernames, per-speaker colour, room and system
  events, players entering and leaving the room. (A private message is always marked
  `(PM)`; that one is not a setting, because a private message that reads like room
  talk is the exact mistake the mark prevents.) The switches are a **snapshot, not a
  filter**: a line is written with the state the settings had at that moment, so
  turning one off never restyles the history you were reading, and turning it back on
  never dresses an old line in something it was not written with. A line written with
  "room and system events" off is kept but not shown — the switches are still not
  deletion. Only the theme and the three sizes re-paint the whole log, because those
  are how it is read rather than what a line was. Four themes:
  - **Default** (big heads) — the theme a fresh install opens on. The face sits in its
    own column at close to the art's native size (4× the text size), the words ride a
    drawn speech balloon beside it, and your own lines mirror to the right. The balloon
    is CSS: a white body with a one-pixel black outline and a two-layer tail (outline,
    then fill one pixel inside it, so the two read as one outlined shape). Its palette
    is the one the game's own art carried — white body, black outline, dark ink, blue
    for your own words — so the balloon is drawn rather than shipped. Private messages
    are the exception: they wear `RADIOBALLOON.BMP`'s yellow starburst, the one sprite
    the extension keeps, because it is the mark that says "not room talk", and it is
    drawn at the art's own 214:128 ratio so the star is never squashed. A line
    with no face yet (or heads switched off) reclaims the avatar's column and loses the
    tail. The timestamp is pinned over the row's corner, out of the flow, and revealed
    on hover — it can never reflow the log. The full time (both ends of a line that
    took a while) is the **stamp's** tooltip, not the row's: a title on the whole line
    turns every hover into a clock and covers the words you were reading, and the stamp
    is visible exactly when you are already pointing at it. With the stamp switched off
    there is nothing to hover, so there is no tooltip either.
  - **Classic** — what the panel looked like before themes existed.
  - **Paper** — a light log and panel.
  - **Terminal (amber)** — amber on near-black.

  The Default move in 0.9.71 carried stored `classic` choices across once, on the
  reasoning that they were the old default and not a decision; picking Classic
  again afterwards is stored as a decision and stands.
- **Settings** — placement and the chat log look, and nothing else that is a
  *setting*: the feed's diagnostics and the frame capture are not decisions a
  player makes, so neither is a row among the switches.
- **The panel itself** — a definite box. Chat is the only view, so nothing can
  change its size; Settings and Debug are a sheet laid over the chat inside it.
  The **Panel** row at the top of Settings places it: *dock left*, *dock right*,
  or *floating*. A docked panel is a full-height column against that side of the
  page. The game's own `#stage` is the box its `c8LayoutGameCanvas()` fits a 4:3
  frame into, so reserving the docked width there moves and rescales the WASM
  screen with the aspect ratio intact, and the page's `ResizeObserver` re-fits it
  live — the canvas itself is never touched. The site's login screen is a separate
  fixed overlay centred on the viewport, and its status line and key cluster are
  centred there too, so those are shifted by half the dock width into the game
  area as well; otherwise the panel would cover the pre-game dialog. The game's own
  **?** and **players** buttons are pinned to the viewport's top-right corner rather
  than centred, so a right dock nudges them left by the whole docked width: they keep
  their margin against the stage's right edge and stay clickable. (Clicking either
  hands the stage back, so the game panel it opens is never covered.) Drag the
  inner edge (or focus it and use the arrow keys) to expand or contract the panel:
  it keeps a 260px width and leaves at least 320px of stage. Floating is the old box: drag the `⠿` grip in
  the header to move it, or any corner to resize; it keeps a 260×220 floor and the
  header always stays on screen. Hiding a docked panel returns the whole stage to
  the game. Placement, dock width, floating position and size all persist.
- **Debug** — a small bug in the bottom-right corner of the settings sheet, dim
  until hovered or focused. It is a footer outside the scrolling body, so it cannot
  scroll away with the switches, and it is **only** in Settings: the chat's corners
  belong to the scrollbar, to the line of text running into them, and to Send, and
  a debug button among the chat is a button that belongs nowhere. It opens the same
  sheet the cog does, with `← Settings` to come back, so it is not a peer of the
  chat. Every frame in and
  out, undecoded; export it to pin down an unknown opcode. This is the tool that
  produced the table above. It shows whether capture is running and how many
  frames have arrived, and refuses to export an empty file — an empty export
  otherwise reads as a bug in whatever you were testing.

### Schtick heads

A line wears the speaker's head, if we know which one it is. The art is already
in the page: the game preloads its whole 18 MB package into the Emscripten
filesystem, and `connect.dat` comes out of that same package, so a head is one
`FS.readFile` of `/release/art/schtick/heads/h<NN><name>/h<NN>s01.bmp` and no
request of its own. There are 37 heads (ids 1–54, with gaps); `s01` is the
standing, front-facing frame, and a head without one falls back to `h01`, `e01`,
`w01`, then anything it has — `h16potato` has no `s`-frame at all.

The frames are 8-bit BMPs with the pixels **run-length coded** (`BI_RLE8`) and
**palette index 63** as the colour key, so they are decoded in the panel, keyed
out into RGBA, and rasterised onto a canvas, which writes the PNG. Handing the
original bytes to an `<img>` would paint a blue box around every face. The pixels
are copied in one at a time: Firefox's content-script sandbox refuses to hand its
own typed array to `putImageData` ("failed to extract Uint8ClampedArray", or
"Permission denied to access object" via `.set()`), and a pixel loop is the one
form of transfer Firefox 158 and Chromium 153 both accept. The key is taken by index, not by colour: entry 63 is `#0800ff` on
most heads but `#0000ff` on `h15bat` and `#0100ff` on `h37pumphead`, so matching
the colour would have left those two wearing a square. Anything the decoder does
not understand yields no icon rather than a broken one.

**A face is remembered.** The head each name is known for is stored, bounded to the
120 most recent, so a record that arrives without schtick parts still wears the face
learned in an earlier session. A record that names somebody headless is also asked
about immediately — the game only sends the parts when it is asked, and a player can be
named long before they speak.

**Which head a player wears rides on the name record.** An `_actorName` value is
followed by the actor's schtick parts — three `u16`s, head, body and feet, as ids
into `/release/art/schtick/{heads,torsos,legs}`:

```
… 06 00 "Blasto" | 05 00 00 00 | 04 00 1c 00 16 00 | 01 03 00 00 …   (that 03 varies: 07 was measured)
                   ^             head  body  feet    ^ the parts record
```

head 4 is `h04fishbowl`, body 28 `t28airplane`, feet 22 `l22gooey`. The record is
the same on all four opcodes that name an actor (`0x02`, `0x04`, `0x09`, `0x14`),
so a speaker's face is known the moment their name is. The offset was confirmed
against players whose heads are known by eye — a goldfish bowl and a robot — and
then against the art itself: **every id parsed out of every capture is a directory
that exists**, which is what says the read is aligned rather than merely plausible.

It is read defensively. The parts record's own `01` marker has to be there, an
id has to be inside 1–54 (`kMaxSchtickID`), and the head still has to have art on
disk before anything is drawn — so a misread yields no icon, never somebody else's
head. Each part stands on its own: an id of 0 means "none", not "misread", so a
record that carries a head and no torso still keeps its head.

**A name can arrive without parts.** Not every record that names an actor carries
the schtick ids: a room roster named Helpbot with no head, while a record the same
server sends for the same Helpbot carries head 12 (`h12robot`). The server re-sends
actor records when the game asks for names — the same PgUp the unnamed-speaker path
uses — so a speaker we can name but cannot draw gets that ask, once per name per
session. The ask is rate-limited, so names that arrive in a burst are queued and
retried when the window passes rather than marked as asked while nothing is
pressed, and it is not gated on the StellaVision flag (off in ordinary play).
Because the press is fire-and-forget and the game can swallow it — a balloon being
committed, a room still connecting — a name is only trusted once the head actually
arrives: if it has not after twelve seconds, the ask is sent again, up to three
times. If the re-sent record has a head, every line that speaker already has is
repainted with it. A player who genuinely wears no schtick simply stays faceless.
The diagnostics record carries `headAsk` (`n` asks sent, `waited` names still
faceless at the recheck), which is what tells "never asked" apart from "asked and
the server had nothing".

**A face is final once the identity settles.** A line keeps asking for one only
while its speaker is still in the room. It is locked — `headLocked`, set together
with `headFixed` — when the actor leaves (opcode 0x05), when a room reuses their id
for a different name, when we move to another room, and when we reconnect to the
same one. At that moment the head the name map knows is written onto the line, and
if there is none the line stays faceless: the name may belong to another player by
then. From there on the name map is not consulted for that line — `chatLine` and
`headIcon` both honour the lock — while a line merely restored from an older store
(which carries `headFixed` but not the lock) may still be filled once, which is how
a faceless line from an older build stops being faceless after an upgrade.

### Talking, and messaging

Keys typed into the panel are kept for the panel — the game calls
`preventDefault()` on keydown, which would otherwise swallow every character
before it reached a field, so typing keys are stopped at the shadow boundary.
The game's own navigation keys are the exception. The four **arrow** keys and
**Control** are handed straight through to the page, so you can keep walking
with the arrows while the chat box still has focus. **Home, End, Insert,
PageUp, PageDown and Delete** go further: they are pressed into the WASM
directly, as scancodes over the same bridge that presses PgUp for names —
page-level passthrough is not delivery — and the panel itself never reacts to
them: no log scrolling, no caret moves in the compose box, anywhere in the
panel.

The box is for the **room**. The picker sets who hears you:

| Selection | Result |
| --- | --- |
| **Say nearby** *(default)* | public speech — only players close enough to see your balloon |
| a player's name | a private message to just that player |

Public speech is not a frame the extension sends. You raise a speech balloon by
typing into the game itself, so the box feeds one character at a time through
`_c8_inject_text_key` and commits with Enter (scancode 40) — the same path the
site's own mobile keyboard uses. The draft stays visible until the agent confirms
that every character was injected and the commit key was accepted; while sending,
additional submissions are ignored. Room input supports printable US-ASCII only
and is limited to 120 characters. Private messages are limited to 180 ASCII
characters — the client's own body cap for the `0x19` frame — and 31-character
recipient names. A longer PM is not refused: it is **split into several messages of
that size**, breaking between words where it can and mid-word only for a single
word longer than the limit, and each part arrives as its own radio balloon in the
log. If a part fails, only the text that was not delivered goes back in the box,
so a retry cannot send anything twice. Unsupported text is rejected without
truncation or substitution. The outgoing room line is shown from the game's echo,
because there is no frame of ours to decode back.

The picker lists the room option first, then players you have recently exchanged
a private message with (either direction), then everyone else online. Each row is
two cells: the name on the left, and on the right, dimmed and flush right, the room
that player was last seen in as the feed reported it — no divider, the alignment
does that job. The sector stands in when `connect.dat` does not name the room, and
players sharing your sector are marked `(here)` beside it: those are the ones a
balloon actually reaches.

It is a button and a listbox rather than a `<select>`, because an `<option>` holds a
single run of text and cannot dim one part of itself or right-align it. The value
still lives in a hidden input, so the compose form sends it exactly as before. Enter
or Space opens the list and the arrows steer it once it is open; closed, the arrows
stay the game's, so you keep walking with the box focused. Enter takes the row the
keyboard is on, Escape puts the list away without choosing, and a click anywhere
else closes it. The list opens upward inside the panel and is given exactly the
height above the compose row on each open, so it cannot be clipped by the pane.

Private messages are the `0x19` / `0x1a` pair and are decoded off the wire in both
directions. They render tinted and tagged `(PM)` so they can never be mistaken for
room talk.

### Room changes

Every room change is written to the log as **two lines, one per event**:

```
LEAVING Your Room
ENTERING Central Fountain
```

The sector stays out of the line and rides in its **title** instead (`11:20:31 · sector 37`,
on hover, for anyone who wants the coordinate): "sector 37" beside "Central Fountain" is
the same room twice, and a coordinate is not a place. A room `connect.dat` does not name
still shows the number, because then the number is all there is.

**The client logs in to each room's server as it arrives, and that login frame
carries the room number.** So a move is named on the wire, both ends at once, the
instant it happens — no feed, no lag:

```
50 71 01 01 | 10 00 | 0c 00 | "8173" | 01 00 00 00 | 2d 49 00 00 | 07 "Blasto" 00 | 25 00 | <key>
 len magic    const   const     ?           ?             ?        ^name pstr     ^room 0x25 = 37
```

The room sits after a length-prefixed name, so it is read at `17 + len` rather than
a fixed offset. It is confirmed three ways in the same second: the login frame said
37, the player feed said `sector: 37`, and the room's chat was talking about the
fountain (`37 = Central Fountain`). The four-character field is *not* a room code —
`8173` appears nowhere in `connect.dat`.

Logging in to the room you are already in is a reconnect, not a move, and says
nothing. A socket on its own is not a move either: it says a connection was made
and nothing about a room, so reconnects and server restarts stay silent. The frame
also carries the name the server knows you by, which is adopted — the game builds
`-vorticouser` from `localStorage` and may only upgrade it from the cookie later, so
the panel can be holding a generated `PlayerXXXXXXX`, a name the feed cannot be
asked about and no other player would recognise.

The feed is **not** consulted for moves. It used to be, for the one case the wire was
thought blind to — two rooms on one server, where no new socket opens. Captured, that
case sends a login frame like any other: three moves in a row (78, 1, 37) all logged
in on the **same socket**, target 9001. The feed only ever added moves that never
happened. It lags, so the room you are not in is what repeats across polls, and two
agreeing readings confirmed it:

```
LEAVING Central Fountain
ENTERING Theme
```

2.5 s after the wire had already put us in 78 and with no frame behind it. The stale
reading also misnamed the next real move's exit — `you left sector 37` when the wire
had us going 78 → 1. So the login frame is the only writer of our room, and
`/api/players` is left to the recipient list, where it belongs. It updates **every
5 s** and runs about **3 s behind**.

That lag is also why the feed is **read on demand** rather than polled. An interval
could only ever hand the dropdown a value from before the last refresh it missed, and
it kept asking while nobody was looking at the list. So the feed is read when the
recipient list is reached for — pointer or keyboard, the read is issued on the way
in, before the popup opens — and again after a move, which is the other thing that
changes what the marks say. Answers younger than ~4 s are reused: the feed only
advances every 5 s, so asking again sooner cannot return anything newer. Sampling on
use cannot be staler than a poll of the same period, and it never asks while nobody
is looking at the list. There is no interval setting left to get wrong.

The names come from the comments in `/release/sys/connect.dat`:

```
  1 'FOUN' 37 '3718' 'TRAN' 'TRAN' 'STLA' 'S022' 0   // Your Room
  ^room  ^tileset ^other ^roomcode  ^transitions        ^the name
```

**The room number is the first column** — the one the login frame and the feed both report. Reading the
column after the tileset code instead is easy to do and yields a plausible-looking
but wrong map, so it is worth stating: that mistake gives room 37 as "Your Room"
and room 35 as "Central Fountain", and collides several numbers (1001, 0202, 3601,
0101, 3718) onto two names each. Keyed correctly there are 53 rooms and no
collisions. The four-character fields are tileset and transition codes and are no
part of a room's name.

**A room is TEAM when a `TEAM` record reaches it and no ordinary record does** — its
only entrance is a TEAM (nozzlebox) entrance, which is the group-entering kind of
room. Hall of Peril (47) is the example. Bridge of Death (48) carries the TEAM exit
*to* Hall of Peril, but ordinary transitions from 25, 30 and 47 enter it as well, so
it stays public. The live file drops the destination from the non-numeric TEAM tags
(`NZBX`, `ENTR`) and has no rows for 54/56, so those five rooms (25, 52, 53, 54, 56)
are kept as a confirmed fallback; the live rule resolves 3 Control Room 1, 5 Seaquest
1, 17/18/19 Super Duper Seaquest, 28 Hall of Noses, 43 Control Room Two, 47 Hall of
Peril and 63 Test Comm-Team Transition. In a TEAM room the guard replaces the chat
(see Features); leaving and re-entering warns again, a same-room reconnect does not.

### Our own connection

The log says when we drop off and come back:

```
DISCONNECTED
RECONNECTED: Central Fountain
```

**A socket closing is the only evidence of going offline** — nothing is ever sent on
a connection that is gone, so there is no frame to watch for — and the agent reports
`close` and `error` on every room socket (`1776` is the metaserver, which is plumbing
rather than the room the player is standing in). It is not proof on its own, though:
**moving rooms closes the old socket too.** So it waits out a 1.5 s grace period,
which the next room's login — or a new socket opening — cancels. A drop that survives
the grace is a disconnect, written once however many sockets report it.

Coming back is the client logging in again. If that login names **the room we are
already in**, nothing moved: the session was re-established, so it is a reconnection.
If it names a different room, it is a move, and the usual pair is written instead.

The room the last session ended in is **remembered** (`lastRoom` in storage), so the
first login frame of a new session can say `reconnected` rather than `entered` — which
is what a browser restart looks like from here. A new session that comes back
somewhere else really did move, and logs the move.

Sockets close too late for the panel to see the end of its own session, so `pagehide`
is the last word: it writes the disconnect immediately, which is also what makes the
next session's `reconnected` follow a real `disconnected` rather than appearing on its
own. That write is best-effort — the page is going away — so a missing line means the
browser did not finish it, not that the session did not end.

### Incoming public speech

Room speech is opcode `0x00`, **streamed one word per frame**:

```
18 71 01 00 | 20 | 4e524276 | 00 | 0d00 | ae | 57444441 | 0500 | 68657921 20
 len  magic    ^   actor      ^   const   ctr   verb      u16      "hey! "
               |  "NRBv"      |                "WDDA"    length
             0x20            NUL
```

**Who is in the room comes off the wire, not the feed.** Every `0x00` event
carries the acting player's tag, so the unique tags seen in a room *are* the room:
an actor can only move while they are in it. A tag that has not been seen before is
somebody arriving, logged the instant they do anything — the player feed is seconds
behind and useless for this.

Movement is the trigger, not speech: a speaker's own line already says they are
here, so announcing them too would put a redundant line in front of every message.
Somebody present but silent is exactly what this adds. Arrivals are seeded from the
roster the server sends when you enter a room, so walking in does not produce a
wall of lines, and an arrival logged under a bare tag is rewritten once its name
record lands.

**Arrivals and departures are `0x04` and `0x05`**, which are exact counterparts.
`0x04` carries an actor record with the `_actorName` property, and lands 2.3 s
before that actor's first movement — it is the only thing that ever names a late
joiner. `0x05` carries nothing but the same 32-bit **actor key** that sits in front
of the id in that record, so it names the leaver back:

```
0x04  … | 89 84 1e 00 | 77 00 0d 00 | … _actorName … "Timmy2EM48"
          ^actor key    ^id 119 = 'w' = the tag "NRBw"
0x05   89 84 1e 00
       ^the same key, and the room is one actor emptier
```

Measured across five captures and three sessions, `key = 1999890 + id`, so a
departure is attributable even for an actor who was never named. A key outside the
room's key space names nobody and is ignored.

Walking into a room also **lists who is already there**, as one line: the server
sends one record per actor, dozens inside the same millisecond, so they are
collected and written once the burst settles. That line is the base set every later
arrival and departure edits, and it is written once per room, so the roster a PgUp
asks for does not add a second one.

The same opcode also carries **actor position updates**, whose verb is `TDPU` and
whose following bytes are signed 16-bit coordinates. Those are rejected by the
length check — a coordinate pair read as a text length overruns the payload,
whereas a real word always fits exactly. A third verb, `SYEK`, has a plausible
length but NUL-padded bytes, so the text is validated byte-by-byte rather than
through `ascii()`, which masks anything unprintable as `.`.

The protocol **marks no end of message** — the balloon simply accumulates until
the speaker stops, so a pause is the only boundary there is. Measured across real
captures, words within one message arrive up to 1.1 s apart while separate
messages are at least 2.2 s apart, so the line is submitted after 3 s of quiet —
high enough that pausing to think keeps a sentence on one line.

**Line end is judged by shape as well as time.** A line longer than ten characters
that ends in sentence punctuation reads as a finished sentence and settles after
1.2 s; anything shorter, or with no punctuation, waits 2.5 s because it could still
be going. Note what counts: a trailing comma or semicolon means the clause is still
running, so treating those as an end splits people mid-sentence.

**A line is not allowed to grow forever.** Twenty seconds of continuous speech is the
limit: past it the line settles where it stands and the next word starts a new one, so
a monologue is a column of readable lines rather than one enormous one. The cap is
measured from the line's own start, not from the last word.

Until then the line is live: it opens on the speaker's first word and grows in
place as the rest arrives, so speech shows up immediately instead of appearing a
pause late.

**A line shows the time it started at, and when it settled is alt text on that same
stamp** — hover it. A message can take twenty seconds to arrive and the log has room
for one time, so the end is written where it does not cost a column. It is stamped
when the line is submitted, which is later than the last word: the pause is what
ends a message, so that is the moment it ended. It is written onto the stamp already
on screen rather than by re-rendering, and it survives storage, so a restored line
still says when it settled. A growing line makes the log taller, so the view is carried down with
it while you are at the bottom — and left alone if you have scrolled back.

A new line is **appended**, not a repaint: rebuilding the log for every new speaker
replaces every node in it, which reads as a jump at exactly the moment somebody
starts talking. Only the growing line's own span, or the one new line, is touched.

Whether to follow new lines is remembered as **state**, not re-derived from
`scrollTop` each time. While the panel is hidden or mid-layout the geometry reads
as "at the bottom" and then reads as "not" once it is shown, so the log stopped
pegging for good; only a real scroll by the reader unsticks it.

**A line with no text is not a line, and is never allowed to become one.** The
client sends a `WDDA` frame whose whole text is a single space — captured verbatim,
length 1 — once when the speech balloon opens and once when it closes. It is not a
message. Dropped rather than trimmed, it opens nothing; a line is created only when
there is text to show, so it is born carrying its own text instead of being pushed
empty and filled in a line later; nothing text-less is ever written to storage; and
anything text-less already in storage from a build that predates all this is dropped
on load rather than replayed. That last part matters because the scrollback is
persisted: a blank written once by an old build was re-shown on every start since,
which is indistinguishable from a blank being produced now. Buffers are keyed by actor tag, so four people typing over each other
get four lines, in the order they started — never one merged line. Only the
growing line's own span is repainted; re-rendering the log per word would jank.
A room change submits whatever is open.

**Speaker names are not in the traffic.** A message carries only an opaque actor
tag (`NRBx` for us, `NRBv` for someone else), which changes between sessions.
Our own speech is shown under our name. Another speaker is shown under their tag
until a name record arrives; lines already on screen are relabelled then.

**Actor ids are per-room, not per-player** — the room you are in hands them out, so
id 118 is one person in one room and somebody else in the next. The name map is
therefore scoped to the current room and dropped on every transition, and a line
is settled once its room is left: `relabelSpeakers` only touches the current
room's lines. Without both halves, re-entering a room rewrote the names on the
entire scrollback.

Names arrive on `0x02`, `0x04`, `0x09` and `0x14`. At *your* entry the server
sends your own `0x02`, while everyone already in the room is named by the entry
snapshot on `0x09`/`0x14`. A player who arrives **after** you is named by `0x04` —
captured arriving 2.3 s before their first movement, which is why the arrival read
`NRBw` until that opcode was decoded. `0x04` carries the same `_actorName` shape as
the roster but is live news, so it is marked `live` and does not seed the
seen-actors set: an actor it has just named has not been announced yet.

The same opcode is a greeting on the metaserver channel, which is why the
extractor, not the opcode alone, decides: a payload with no `_actorName` record
decodes to nothing either way.

The first line from an unknown tag — and an unnamed arrival — also presses PgUp,
which asks the game for the names it does not volunteer. This is **not** a setting.
It was one while the press was believed to flash names over every actor in the game
window, but the press is a fallback: the entry snapshot names everyone already in
the room and `0x04` names most arrivals, so it fires only for the residue and the
flash is not something a player could connect to anything. The toggle is gone, and
a stored `askNames: false` is dropped on load rather than left as a switch with no
control behind it.

### On sending

Private messages are written as a `0x19` frame directly. That is the one place the
extension synthesises a protocol frame instead of driving the game's UI; it is
byte-for-byte what the client itself emits from the StellaVision compose screen,
and the codec enforces the client's own length limits. Everything else
(public speech, key input) goes through the game's exported input API.

## Status of each feature

Verified against the running game or against real captured bytes:

- message send/receive, player search and room transfers — **decoders unit-tested
  against the actual captures**, and the send encoder reproduces the captured
  frame byte for byte
- the WebSocket tee (socket wrapping, `instanceof` preserved, send/receive tapped)
- the `c8SetControlState` tap and the StellaVision menu labels it carries
- key and text injection through `_c8_inject_key` / `_c8_inject_text_key`
- player search and sector → room-name resolution from `connect.dat`
- the schtick-head art path: the FS read, the `BI_RLE8` decode and the colour key
  are unit-tested against a hand-built RLE8 frame — runs, a padded literal, the
  bottom-up row order and the palette-index key — and the decoded RGBA is asserted
  where it reaches the rasteriser, not in a screenshot
- the schtick parts on the actor record — three captures, three players, asserted
  against heads known by eye, and every id cross-checked against the art tree

Still not decoded, with the Debug pane there to finish them:

- inventory (`_HandleInventoryReportMsg`) and stash payload layouts. The stash is
  reachable in-game: StellaVision's fourth screen carries `Drop | Switch | Stash`
- postcards/mail, which are a separate path from StellaVision messages
