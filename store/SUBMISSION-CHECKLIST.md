# Submission checklist — C8 Chat 1.0.0

## Preflight

- [ ] Permission from the Castle Infinity operators for WebSocket tapping, key
      injection, the private-message frame, docked layout adjustments, and runtime
      schtick art — or a decision to publish unlisted/self-distributed instead.
- [ ] Chrome Web Store developer account, fee paid, Trader/Non-Trader declared.
- [ ] Mozilla Account with 2FA enabled; AMO developer profile set.
- [ ] Support email confirmed: dion.jones@gmail.com.
- [ ] Privacy policy live at
      https://dionjones615.github.io/C8chat-privacy/.
- [ ] Public privacy repository exists and GitHub Pages is enabled.
- [ ] Screenshots reviewed for real player names/personal data.

## Build

- [ ] `npm ci`
- [ ] `npm run check`
- [ ] `npm run smoke` (or record that it was not run)
- [ ] Firefox temporary-add-on check (or record that it was not run)
- [ ] `dist/c8-chat-1.0.0-chrome.zip` exists.
- [ ] `dist/c8-chat-1.0.0-firefox.xpi` exists.
- [ ] `dist/c8-chat-1.0.0-source.zip` exists.
- [ ] `dist/SHA256SUMS` exists.
- [ ] `manifest.json` is at the archive root.
- [ ] No `test/`, `store/`, `docs/`, `scripts/`, or `node_modules/` in the
      extension archives.
- [ ] Icons 16/32/48/128 are present and the correct size.
- [ ] No embedded game art data URLs in `src/panel.css`.

## Chrome Web Store

- [ ] Add new item, upload the Chrome ZIP.
- [ ] Name: C8 Chat.
- [ ] Short description: manifest description.
- [ ] Detailed description includes features, requirements, privacy, and the
      unofficial disclaimer; no inventory/postcard/macro claims.
- [ ] Category: Social & Communication; language: English (US).
- [ ] Store icon 128×128, 1–5 screenshots at 1280×800, 440×280 promo tile.
- [ ] Privacy practices: single purpose, `storage` and host-permission
      justifications, remote code “No”, data-usage matrix, Limited Use
      certification, privacy URL.
- [ ] Distribution: Public, all regions, free.
- [ ] Test instructions entered.
- [ ] Trader declaration completed.
- [ ] Submit for review; monitor email.

## Firefox AMO

- [ ] Create the add-on (or reuse the existing one with the same ID); do not
      create a duplicate.
- [ ] Upload `dist/c8-chat-1.0.0-firefox.xpi`.
- [ ] Name: C8 Chat; slug `c8-chat` if available.
- [ ] Summary (≤250) and description include the unofficial disclaimer; no
      inventory/postcard/macro claims.
- [ ] Categories: Social & Communication; optional Games & Entertainment.
- [ ] Support email: dion.jones@gmail.com.
- [ ] License: MIT.
- [ ] Privacy policy checked with the public URL.
- [ ] Source code: No; `README-BUILD.md` and source archive ready if asked.
- [ ] Data collection: `required: ["none"]`; reviewer notes explain local-only
      storage and the private-message edge.
- [ ] Notes for reviewers entered.
- [ ] Submit; monitor email.

## Post-publication

- [ ] Install from both stores in clean profiles; verify the panel, docking, and
      recipient list.
- [ ] Update README/store links.
- [ ] Confirm the privacy URL still works.
- [ ] Tag the release and keep the artifacts attached.
- [ ] Before making the repository public: sanitize local paths/profile IDs,
      review screenshots, scan history for secrets, enable secret scanning and
      CodeQL if available.
