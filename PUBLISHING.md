# Publishing C8 Chat

This is the release and store-submission runbook. The extension is a
dependency-free Manifest V3 package; the release archives are built by
`scripts/package.mjs`.

## 1. Prerequisites and decisions

- **Chrome Web Store:** Google developer account, one-time registration fee
  (US$5 at the time of writing), and the Trader/Non-Trader declaration.
- **Firefox AMO:** Mozilla Account with 2FA enabled. Choose a license (MIT is
  used by this repository) and accept the distribution agreement.
- **Support email:** dion.jones@gmail.com
- **Privacy policy URL:** https://dionjones615.github.io/C8chat-privacy/
- **Public source:** `https://github.com/DionJones615/C8chat` (private until the
  public-launch checklist is complete).
- **Unofficial disclaimer:** “Not affiliated with Castle Infinity, its
  preservation project, or any rights holder.”

Before submitting, confirm the project has permission for the behaviour that
touches the game: reading its WebSocket, injecting keys, sending the game's own
private-message frame, adjusting the stage/overlay layout when docked, and
displaying runtime schtick art. The extension does not redistribute the game's
balloon art. If permission is not granted, do not submit a public listing.

## 2. Build and verify

```sh
npm ci
npm run check
```

`npm run check` runs `web-ext lint` on `dist/unpacked`, the Node test suite, and
the packaging script. It writes:

- `dist/c8-chat-<version>-chrome.zip`
- `dist/c8-chat-<version>-firefox.xpi`
- `dist/c8-chat-<version>-source.zip`
- `dist/SHA256SUMS`

The Chrome and Firefox archives contain `manifest.json`, `src/`, and `icons/`.
The source archive adds tests, scripts, and documentation. There is no build
step; the source archive is the code that produced the package.

Run the browser checks described in `AGENTS.md`:

- Headless Chromium + CDP: load `dist/unpacked`, verify `#c8-chat-host` and the
  panel, open Settings, exercise floating/dock left/dock right.
- Firefox + the `browser-extensions` distrobox: temporary add-on, verify the
  panel, the popup, the player feed, and that `about:addons` shows no data
  collection.

Do not claim a browser was verified unless the check actually ran.

## 3. Chrome Web Store fields

Upload `dist/c8-chat-<version>-chrome.zip` in the developer dashboard.

- **Name:** C8 Chat (from the manifest; finalize before upload).
- **Short description:** the manifest description (≤132 characters).
- **Detailed description:** IRC-style chat log with schtick heads, room roster,
  joins/leaves, private messages with recipient list and `(here)` marks, dock
  left/right/float, themes and settings. State the requirements (Chrome 121+),
  the local-only data handling, and the unofficial disclaimer. Do not claim
  inventory, stash, postcards, macros, or automation.
- **Category:** Social & Communication.
- **Language:** English (United States).
- **Store icon:** 128×128 PNG.
- **Screenshots:** 1–5 at 1280×800; show floating, docked right, docked left,
  Settings, and chat/PM.
- **Small promo tile:** 440×280 PNG/JPEG (required).
- **Privacy practices:**
  - Single purpose: an unofficial chat and room panel for Castle Infinity.
  - Justify `storage`: local chat scrollback, settings, recent recipients, last
    room, and diagnostic samples.
  - Justify `https://www.castleinfinity.com/*`: the extension only runs on the
    game page and needs the page's own WebSocket/DOM to build the panel.
  - Remote code: **No, I am not using remote code.**
  - Data usage: select Personally identifying information (player/user names),
    Personal communications (chat/PM text), and Website content (game page and
    WebSocket data); explain that processing is local. Do not select health,
    financial, location, or web history.
  - Limited Use: certify all applicable statements.
  - Privacy policy URL: https://dionjones615.github.io/C8chat-privacy/
- **Distribution:** Public, all regions, free.
- **Test instructions:** open the game and wait for it to load; the panel opens
  floating (if hidden, click the gold ∞ button). Open Settings → Panel, try Dock
  left/right/Floating, and open the recipient list. No credentials are supplied;
  the game creates a guest account on first login.
- **Trader declaration:** complete it. For a free, non-commercial hobby
  extension, Non-Trader is the usual choice; this is the publisher's own legal
  determination.

## 4. Firefox AMO fields

Upload the XPI/ZIP in the AMO Developer Hub.

- **Name:** C8 Chat.
- **Add-on URL:** `c8-chat` if available; otherwise a close variant.
- **Summary:** a short version of the manifest description (≤250 characters).
- **Description:** the Chrome detailed description, plus the unofficial
  disclaimer. Mention the docked/floating panel and the page reflow.
- **Categories:** Social & Communication; optionally Games & Entertainment.
- **Experimental:** No.
- **Requires payment:** No.
- **Support email:** dion.jones@gmail.com
- **License:** MIT (or the chosen license).
- **Privacy policy:** check the box and use
  https://dionjones615.github.io/C8chat-privacy/
- **Source code:** answer **No**. The package is hand-written ES5 with no
  minifier, bundler, or transpiler; `README-BUILD.md` and the source archive are
  available if a reviewer asks.
- **Notes for reviewers:** test steps; no credentials needed; the MAIN-world
  script wraps the page's own WebSocket without redirecting it; the panel
  synthesizes the game's own `0x19` private-message frame only when the user
  sends one; the account key is redacted in memory; docked mode adjusts the
  game's stage/overlay to make room; no remote code; no data is sent to the
  developer; inventory/stash/postcards are not implemented.
- **Data collection:** the manifest declares `required: ["none"]`. All storage is
  local and no data is transmitted to the developer or a third party. If AMO
  challenges the synthesized private-message frame, change the declaration to
  `required: ["personalCommunications"]`, update this policy and the listing, and
  re-submit.

## 5. First submission versus automated updates

The first Chrome item and the first AMO add-on must be created manually in the
respective dashboards. After they exist, store credentials can be added to the
GitHub `store-publish` environment:

- `WEB_EXT_API_KEY`, `WEB_EXT_API_SECRET` (AMO API keys)
- `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` (Chrome Web Store API
  OAuth credentials)
- `CWS_EXTENSION_ID` (the item ID from the dashboard URL)

The `publish-stores.yml` workflow is manual and environment-gated. It builds and
verifies the tag, then runs `web-ext sign --channel listed` for AMO and
`chrome-webstore-upload-cli` for CWS. Use the `dry_run` input first.

## 6. Release sequence

1. Bump `manifest.json` and `package.json` together; update `CHANGELOG.md`.
2. Run `npm ci && npm run check`.
3. Commit and tag `v<version>`; push the tag.
4. `release.yml` verifies the version, runs the checks, and creates the GitHub
   Release with the Chrome ZIP, Firefox XPI, source ZIP, and `SHA256SUMS`.
5. Submit the release artifacts to the stores (first time manually; later via the
   publish workflow).
6. Monitor review email. Respond with the source archive or reviewer notes if
   asked. Do not change unrelated code in a correction submission.
7. After publication, install from both stores in clean profiles and update the
   README links.

## 7. Public-launch checklist

Before changing the repository from private to public:

- Sanitize local paths and profile IDs in `AGENTS.md` and `README.md`.
- Review screenshots and docs for real player names or personal data.
- Run a secret scan over the git history (`gitleaks`/`trufflehog`).
- Confirm no store credentials, `.env` files, or API keys are committed.
- Enable secret scanning/push protection and CodeQL if the plan supports it.
- Keep the public privacy repository stable; do not break the store policy URL.
- Update badges, store links, and the support URL.
