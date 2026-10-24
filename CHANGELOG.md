# Changelog

All notable changes to C8 Chat are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- TEAM rooms — the group-entering kind, whose only entrance is a TEAM entrance, such
  as Hall of Peril — replace the chat with a dismissible "This might be a little
  cheaty in this room" notice so the panel does not offer a shortcut there by
  accident. **That's OK** reveals it for that room visit, and the transcript keeps
  filling behind the notice.

### Changed

- Schtick heads scale as a percent of each head's own native size instead of
  being stretched to a shared height or width, so differently shaped faces keep
  their true proportions next to each other. The head-size setting is a
  percentage now (50–200%); the old pixel choices fall back to the theme default.
- The panel↔agent bridge marker is `__c8_chat__` (was `__c8_companion__`, an old
  name). A page that kept the previous build's agent across an extension reload is
  bridged by a small relay, so the panel works there without a tab reload.

## [1.1.0] - 2026-10-24

### Added

- GitHub Releases distribution: Chromium-based users load the unpacked package,
  and Firefox-based users install the AMO-signed XPI.
- Firefox unlisted signing workflow and an `update_url` update manifest.
- Stable release asset names for the latest-download links.

### Changed

- Clicking the toolbar icon opens Castle Infinity in a tab that already has it,
  or a new tab when none is open. The status popup is gone.
- Store-specific listing documents, the Chrome Web Store publish workflow, and
  the store upload dependency were removed; the manifest remains store-compatible
  for a future listing.

## [1.0.9] - 2026-10-23

### Fixed

- **A written `LEFT:` line is history and is never rewritten.** The relabeller
  recomputed every presence line from the name map as it stood, so a named departure
  became `LEFT: someone` once that name was cleared — and could take the name of
  whoever next wore the id. Departures are committed on write and skipped by the
  relabeller; arrivals still rename while their line is open.
- A second copy of the same departure frame no longer prints a second line, even when
  it arrives after the id has been reused (same key, different player). A copy within
  two seconds is ignored; a genuine later departure is still announced.

## [1.0.8] - 2026-10-23

### Changed

- A departure line is written only when the panel can attribute it: the actor's name
  is known, or the actor was seen moving about this room. `LEFT: someone` is gone —
  the server repeats some frames and the second copy arrives after the name was
  consumed, and a leave that lands before a room's name records can be attributed to
  nobody.

## [1.0.7] - 2026-10-23

### Fixed

- **A player whose parts record has a marker of `01 07` now keeps their face.** The
  decoder required the marker's second byte to be exactly `03`, which is what most
  records carry; one player's record measures `07`, so his head, body and feet were
  in the payload and thrown away — reported as "faceless" while the wire was fine.
  The marker's first byte and its zero padding are still required.

## [1.0.6] - 2026-10-23

### Fixed

- **Reverted the actor-table read from the game's heap.** This build's Emscripten
  module does not export `HEAPU8`, and reading that property aborts the runtime —
  which broke the game's own startup. A player the wire names without schtick parts
  is reported as such in the diagnostics instead; nothing touches `Module` beyond the
  exports the game documents.

## [1.0.5] - 2026-10-23

### Fixed

- A player the wire names without schtick parts now gets a face anyway. The server
  only sometimes includes the parts in an actor record, so the client itself is
  asked: its heap holds the same record, and the agent harvests the actor table once
  (chunked across ticks, so the game does not stall) and answers by name. Verified
  against a captured record — Helpbot, head 12, body 53, feet 29 — and the answer is
  remembered like any other face, so it survives the session.

## [1.0.4] - 2026-10-23

### Fixed

- A capture export now keeps whole frames. The room roster arrives as one ~8 KB
  frame and the export cut it at 4 KB, so the records for everyone but the local
  player were missing from every export. The cap is 64 KB while capturing and
  unchanged otherwise.
- The actor sample is taken from any frame that named somebody it could not dress,
  instead of filtering on the frame's first message type — a roster frame leads with
  the sector list, so the old filter sampled the map and skipped the records.

## [1.0.3] - 2026-10-23

### Added

- The diagnostics now keep the raw window where an absent schtick-parts record would
  sit, and only sample roster frames. A player the wire names without parts is the one
  remaining "faceless" case, and this records whether the parts are missing or merely
  at a shifted offset.

### Fixed

- The actor-frame sample was being spent on sector-list frames (`0x14`), which decode
  as actors but carry the map, so the roster was never retained.

## [1.0.2] - 2026-10-23

### Fixed

- The speech balloon's tail is centred while the line is short, so a one-line bubble
  no longer has its tail hanging out of the bottom corner; on a wrapped line it still
  sits at the speaker's first row.
- A player named by an actor record without schtick parts is asked for at once,
  instead of only being asked when they next speak — the game only sends the parts
  when it is asked, so waiting left them faceless.
- The head each player is known for is stored, so a record that comes back without
  parts still wears the face learned in an earlier session.

## [1.0.1] - 2026-10-23

### Fixed

- The Default theme's speech lines read as balloons again. The balloon is drawn
  in CSS from the palette the removed game art carried: white body, one-pixel black
  outline, a two-layer tail, blue for your own words.
- Private messages wear the game's radio starburst again. It is the one sprite the
  extension ships, because it is the mark that tells a private message apart from
  room talk; the speech balloons stay drawn.

## [1.0.0] - 2026-10-23

### Added

- Renamed the extension from Castle Companion to C8 Chat.
- Original 16/32/48/64/128 px icons and a 128 px store icon.
- Public browser-store privacy policy and reviewer-facing data-disclosure notes.
- GitHub repository automation: CI on pull requests and pushes, tag-driven
  releases with Chrome/Firefox/source archives and checksums, and a manual,
  environment-gated store-publish workflow.
- Contributor documentation, issue/PR templates, security policy, and code of
  conduct.

### Changed

- The panel can now be docked left, docked right, or left floating; placement,
  dock width, and floating geometry persist.
- Private browsing is disabled (`"incognito": "not_allowed"`) so chat logs and
  settings from private sessions cannot be stored in shared extension storage.
- Packaging is now reproducible through `scripts/package.mjs`; the old
  hand-built XPI is no longer committed.
- The default big-head theme uses the plain CSS speech bubble; the game's own
  balloon art is no longer embedded in `src/panel.css`.

### Fixed

- The player feed now uses an absolute URL, so Firefox content scripts reach
  `https://www.castleinfinity.com/api/players` instead of the extension origin.
- The toolbar status text no longer claims the panel only appears on the right
  edge; it explains docking and floating.
- The manifest description no longer claims unimplemented inventory or macro
  features.

### Security

- The account session key remains redacted in memory before any diagnostic data
  is stored.
- The extension loads no remote code and uses only the declared `storage`
  permission plus the Castle Infinity host permission.
