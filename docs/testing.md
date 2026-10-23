# C8 Chat — testing notes

## Tests

```sh
npm ci
npm test
npm run lint
npm run package
```

`npm run check` runs the package/lint/test sequence in one go. `npm test` covers
protocol, agent, panel, site-access, manifest, package-archive, and repository
layout. `npm run lint` packages `dist/unpacked` and runs:

```sh
web-ext lint --source-dir dist/unpacked --warnings-as-errors
```

The deterministic test harnesses cover the toolbar status page, chat
drafts/acknowledgements, input readiness, the dock/floating placement controls,
and when the player feed is read (at boot, on reaching for the recipient list,
and no more often than its freshness window allows). Browser smoke checks use
the procedures in [AGENTS.md](../AGENTS.md): headless Chromium plus the DevTools
protocol (no Selenium/Playwright package needed) and Firefox 158 via the
`browser-extensions` distrobox with geckodriver/Selenium (temporary add-on).
Both verify the injected host element, the panel, and the MAIN-world agent. The
panel also writes a boot marker to `chrome.storage.local` under `diag`, which
makes an installed browser verifiable from its profile directory instead of by
eye.

`protocol.test.mjs` covers the frame splitter, the channel/opcode split,
string readers, sector-list decoding, every decoder in the table above, the
schtick parts (asserted on three real records from three players), the
send encoder (asserted byte-identical to a real capture) and account-key
redaction — all against real byte strings.

`panel.test.mjs` runs `panel.js` against a minimal DOM stub that models
document-order `getElementById` and per-element event handlers. It covers the
chat pane being built and the decode → IRC line path
for each message kind, duplicate suppression, per-speaker speech stitching, room
changes named off the login frame and resolved to names out of `connect.dat`, the
scrollback surviving a trip through the settings sheet, and the schtick head —
which frame is chosen for a head (including one with no `s`-frame), the RGBA the
BMP decoder produces as it reaches the rasteriser, a head that cannot be read
being settled rather than re-read on every repaint, and one line driven end to end
by the real bytes the room sent on entering Central Fountain.

`agent.test.mjs` runs `agent.js` against a stub of the page, and covers the key
recorder's shadow-boundary guard, the account-key scrub, and the filesystem reads
the art and the room map come out of.
