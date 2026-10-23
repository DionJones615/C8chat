# Changelog

All notable changes to C8 Chat are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
