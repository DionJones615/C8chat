# Distributing C8 Chat

C8 Chat is distributed through GitHub Releases. There is no Chrome Web Store or
public AMO listing. The manifest remains store-compatible so a listing can be
added later.

## Release assets

The release workflow writes versioned artifacts and stable aliases:

| Asset | Use |
| --- | --- |
| `c8-chat-<version>-chrome.zip` | Versioned Chromium-based package |
| `c8-chat-chrome.zip` | Stable alias for the latest Chromium-based link |
| `c8-chat-<version>-firefox-unsigned.xpi` | Versioned unsigned Firefox build |
| `c8-chat-firefox-unsigned.xpi` | Stable unsigned alias |
| `c8-chat-<version>-firefox-signed.xpi` | Versioned AMO-signed Firefox build |
| `c8-chat-firefox-signed.xpi` | Stable signed alias for the latest Firefox-based link |
| `c8-chat-<version>-source.zip` | Versioned source archive |
| `c8-chat-source.zip` | Stable source alias |
| `SHA256SUMS` | Hashes for every uploaded asset |

The README and `docs/INSTALL.md` use the stable aliases:

- `https://github.com/DionJones615/C8chat/releases/latest/download/c8-chat-chrome.zip`
- `https://github.com/DionJones615/C8chat/releases/latest/download/c8-chat-firefox-signed.xpi`

The Firefox update manifest uses the versioned signed URL so it pins a release.

## Release sequence

1. Bump `manifest.json` and `package.json`, and add the `CHANGELOG.md` section.
2. Update `docs/updates.json` and run the checks:

   ```sh
   node scripts/updates.mjs
   npm ci && npm run check
   ```

3. Commit, tag `v<version>`, and push the tag. `.github/workflows/release.yml`
   verifies the version and creates the GitHub Release with both versioned and
   stable assets.
4. Run `.github/workflows/sign-firefox.yml` with the tag. It signs the Firefox
   package as an **unlisted** AMO add-on and uploads the signed versioned and
   stable assets.
5. Verify the latest-download links while logged out and check `SHA256SUMS`.

## AMO unlisted signing

The API key page is:

<https://addons.mozilla.org/developers/addon/api/key/>

Enable two-factor authentication on the Mozilla Account first. The page shows a
**JWT issuer** and **JWT secret**; the secret is shown only when generated.

Store them as secrets in the `signing` GitHub environment:

```sh
gh secret set WEB_EXT_API_KEY --repo DionJones615/C8chat --env signing
gh secret set WEB_EXT_API_SECRET --repo DionJones615/C8chat --env signing
```

The first unlisted submission needs the add-on metadata. If the add-on
`c8-chat@dionjones615.github.io` does not exist yet, submit the unsigned Firefox
package once through the AMO Developer Hub:

1. Open <https://addons.mozilla.org/developers/> and choose **Submit a New
   Add-on**.
2. Choose **On your own site** (unlisted).
3. Upload `dist/c8-chat-<version>-firefox-unsigned.xpi`.
4. Set the name, MIT license, privacy-policy URL, and reviewer notes. The
   manifest already declares `data_collection_permissions: none`.
5. After the add-on exists, run `sign-firefox.yml` for this and later versions.

The signing workflow runs:

```sh
npx web-ext sign \
  --source-dir dist/unpacked \
  --artifacts-dir dist/signed \
  --channel unlisted \
  --api-key "$WEB_EXT_API_KEY" \
  --api-secret "$WEB_EXT_API_SECRET" \
  --no-input
```

## Firefox updates

The manifest points at:

`https://dionjones615.github.io/C8chat/updates.json`

That file is served from this repository's Pages site (`/docs`). The update
manifest uses the versioned signed XPI and the add-on ID. The URL is sticky:
Firefox keeps the installed version's `update_url`, so do not move it without an
enterprise-policy migration path.

## Chromium-based browsers

There is no one-click install from GitHub. Users extract
`c8-chat-chrome.zip`, enable Developer mode on the browser's extensions page,
and Load unpacked the folder. There is no auto-update; users replace the folder
and click Reload.

Chrome 137 removed `--load-extension` from branded Chrome builds. The
extensions-page UI remains; Chromium and Chrome for Testing still accept the flag
for development. Do not promise CRX drag-install or enterprise auto-updates.

## Firefox-based browsers

Users install the signed XPI from `about:addons` → gear → **Install Add-on From
File**. GitHub may serve the XPI as a download rather than an install prompt.
The unsigned XPI is for development, or for forks that explicitly allow unsigned
add-ons; stock Firefox requires the signed build.

## Security notes

- Do not commit the AMO JWT secret.
- Keep the `signing` environment restricted to maintainers.
- Keep `SHA256SUMS` with the release and verify assets before installing.
- Do not delete a release that `docs/updates.json` points to.
