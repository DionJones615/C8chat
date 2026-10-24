# Install C8 Chat

C8 Chat is distributed through GitHub Releases. Download the asset for your
browser family from the latest release:

<https://github.com/DionJones615/C8chat/releases/latest>

## Chromium-based browsers

Chrome, Chromium, Edge, Brave, Vivaldi, Opera, and other Chromium-based
browsers use the same unpacked package. Requires Chromium 121 or newer.

1. Download [`c8-chat-chrome.zip`](https://github.com/DionJones615/C8chat/releases/latest/download/c8-chat-chrome.zip).
2. Extract the ZIP to a permanent folder. The folder must contain `manifest.json`
   at its root.
3. Open the browser's extensions page:
   - Chrome/Chromium: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
4. Enable **Developer mode**, choose **Load unpacked**, and select the extracted
   folder.
5. Open <https://www.castleinfinity.com/> and reload the tab. Click the C8 Chat
   toolbar icon to focus an open game tab, or open a new one.

Chromium-based browsers do not auto-update unpacked extensions. To update,
replace the folder contents with the newer release and click **Reload** on the
extensions page. Chrome 137 removed the `--load-extension` command-line flag from
branded Chrome builds; the extensions-page UI is the supported path. Some
managed browsers may block developer-mode extensions by policy.

## Firefox-based browsers

Firefox, LibreWolf, Waterfox, and other Firefox-based browsers use the signed
XPI. Requires Firefox 142 or newer.

1. Download [`c8-chat-firefox-signed.xpi`](https://github.com/DionJones615/C8chat/releases/latest/download/c8-chat-firefox-signed.xpi).
2. Open `about:addons`, click the gear button, and choose **Install Add-on From
   File**.
3. Select the downloaded XPI and confirm the install.
4. Open <https://www.castleinfinity.com/> and reload the tab. Click the C8 Chat
   toolbar icon to focus an open game tab, or open a new one.

The signed XPI is the supported Firefox-based build; Firefox updates it through
the extension's `update_url`. The unsigned XPI on the release page is for
development, or for forks that explicitly allow unsigned add-ons; stock Firefox
requires the signed build.

GitHub serves release assets as downloads. If clicking the XPI downloads it
instead of opening the install prompt, save it and use **Install Add-on From
File**.

## Checksums

Every release includes `SHA256SUMS`:

<https://github.com/DionJones615/C8chat/releases/latest/download/SHA256SUMS>

Verify a downloaded asset before installing it:

```sh
sha256sum -c SHA256SUMS --ignore-missing
```

## Source

The source archive is attached to each release, and the repository is public:

<https://github.com/DionJones615/C8chat>
