# C8 Chat — agent notes

Workspace instructions for anyone (human or agent) working in this repo. The
project is a dependency-free MV3 extension for https://www.castleinfinity.com;
there is no build step, only `scripts/package.mjs` packaging.

## Why the manifest uses required host access

Earlier builds declared Castle Infinity as an `optional_host_permissions` entry
and registered the content scripts at runtime from the popup. In a Firefox-based
test browser the `permissions.request()` grant never persisted
(`userPermissions.origins` stayed `[]`), so nothing injected and the panel
silently never appeared. The manifest now declares `host_permissions` and ships
the agent (MAIN world, `document_start`) and panel (isolated, `document_idle`)
as static `content_scripts`. Browsers grant declared host access during
installation, so injection needs no click. Do not "fix" this back into an
optional permission gate without re-testing.

## Installing in a Firefox-based browser

For development, open `about:debugging#/runtime/this-firefox`, choose **Load
Temporary Add-on…**, and select `manifest.json`. That click is a browser-chrome
step an agent cannot perform; ask the user to do it.

For a signed build, open `about:addons` → gear → **Install Add-on From File** and
select the signed XPI. Stock Firefox requires the signed build. An unsigned XPI
is for development, or for a fork/profile explicitly configured to allow it; do
not change a daily browser profile to bypass signing.

If the browser is sandboxed (for example a Flatpak), it may only see
`~/Downloads`. Stage the XPI there first:

```sh
cp dist/c8-chat-<version>-firefox-unsigned.xpi "$HOME/Downloads/c8-chat.xpi"
```

Open the staged file with the browser's own launcher and ask the user to confirm
the install dialog. Do not pass `--profile`, `--new-tab`, or a `moz-extension://`
URL while the browser is running; that can be treated as a second launch and look
like a crash. Open tabs with a plain URL instead.

To verify an install from disk, find the profile path in `about:profiles`, then
read `<profile>/extensions.json` and look for the add-on id
`c8-chat@dionjones615.github.io`. `active: true` plus the expected `version`
means the browser is running the new build; a tab reload is enough, no restart.

## Installing in Chromium

Chromium may not be able to read this directory when it is sandboxed. Stage an
unpacked copy somewhere the browser can see, for example:

```sh
npm run package:unpacked
rm -rf "$HOME/Downloads/c8-chat/chromium"
mkdir -p "$HOME/Downloads/c8-chat/chromium"
cp -r dist/chromium-unpacked/. "$HOME/Downloads/c8-chat/chromium/"
```

Then open the browser's extensions page, enable **Developer mode**, and **Load
unpacked** `$HOME/Downloads/c8-chat/chromium`. The extension id is assigned by the
browser and varies with the path; read it from the browser's Preferences or the
extensions page.

Chrome 137 removed `--load-extension` from branded Chrome builds. Chromium and
Chrome for Testing still accept it for development; the extensions-page UI is the
supported path for stable Chrome. A CRX can be packed from the staged directory
with a local PEM for a stable id, but it is not a distribution path for stable
Chrome.

## Verifying in Chromium headlessly

No Selenium or Playwright package is needed: headless Chromium plus the DevTools
protocol, driven by Node 22+ (global `WebSocket`). Launch with a throwaway
profile so the user's session is untouched:

```sh
"${CHROME_BIN:-$HOME/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome}" \
  --headless=new --no-sandbox \
  --user-data-dir="$HOME/Downloads/c8-chat/.probe-profile" \
  --load-extension="$HOME/Downloads/c8-chat/chromium" \
  --remote-debugging-port=9333 about:blank
```

`Page.navigate` to the game, then read the panel out of the shadow root:
`#c8-chat-host` → `shadowRoot.getElementById('panel')`. A sandboxed Chromium can
be launched through its Flatpak wrapper the same way.

To exercise rendering that needs game data, load a copy whose manifest keeps only
the panel's content script and impersonate the agent from the page:

```js
window.postMessage({ __c8_chat__: 1, k: 'reply', id, ok: true, value });
```

That lets `readDir`/`readBytes` answer with a synthetic BMP, which is how the
schtick-head path is checked without a live game.

## Verifying in Firefox

The `browser-extensions` distrobox carries Firefox, geckodriver, and Selenium.
Serve a page, load a copy of the extension whose manifest matches it, and drive it
with Selenium:

```sh
distrobox enter browser-extensions -- bash -lc '
  cd <site-dir> && python3 -m http.server 8802 &
  sleep 1 && python3 run.py
  pkill -f "http.server 8802"'
```

`run.py` needs `Service('/usr/local/bin/geckodriver')` and
`opts.binary_location = '/usr/bin/firefox'` — Selenium 4.20's own manager is not
usable in that image — then `driver.install_addon(dir, temporary=True)`,
`driver.get(url)`, and `execute_script` to read the panel out of its shadow root
(the page can, `mode: 'open'`). Give the page a fake agent the same way as the
Chromium probe. That is how the head-art path was proven on Firefox 158.

**Do not hand a typed array to a canvas from a content script.** In the isolated
world `putImageData(new ImageData(ownUint8ClampedArray, w, h))` throws
`InvalidStateError: failed to extract Uint8ClampedArray`, and `img.data.set(ownArray)`
throws `Permission denied to access object`; only element-wise assignment into the
context's own `createImageData(...).data` works. That is why the head PNG is
written by a pixel loop, not by `.set()` or an OffscreenCanvas.

## Reading the panel's diagnostics

The panel writes `chrome.storage.local` every 5 seconds: `diagJson` (counts,
actor samples, last line, errors) plus base64 blobs. Firefox stores it in the
profile's extension IndexedDB with byte-shifted keys (`diag` → `0ejbh`,
`diagJson` → `0ejbhKtpo`). The value is a **Snappy stream** (LEB128 length, then
literal/copy tags) holding the JSON as **UTF-16LE**, so eyeballing fragments reads
only the literal runs. Decode it properly instead — a ~40-line Snappy block
decoder is enough, then `bytes.decode('utf-16-le')` from the `{"build"` offset.
Chromium stores it under `<profile>/Local Extension Settings/<id>/` as a LevelDB
log whose value is a **JSON string literal** — parse from `"` after the key to
the closing unescaped quote, then `json.loads` twice (literal, then the record).

That is how the "missing heads" question is answered: the record shows `head: 1`
for your own actor and `head: null` for players whose schtick parts never arrived.
Not a rendering fault.

## Package, test, lint

```sh
npm ci
npm test
npm run lint
npm run package
npm run smoke
```

`npm run check` runs the package/lint/test sequence. The extension artifact holds
`manifest.json`, `src/`, and `icons/` and nothing else. `scripts/package.mjs`
stages both the Firefox manifest (`background.scripts`) and the Chromium manifest
(`background.service_worker`), then writes versioned and stable archives plus
`SHA256SUMS`. Do not go back to a hand-built `web-ext build` unless bootstrapping
without `package.json`: `'test/**'` alone leaves an empty `test/` entry in the zip,
which is why the directory is ignored.

## Reporting rules for this repo

- Never say a browser was fixed or verified unless a check above actually ran;
  state which one ran and its output.
- Do not leave browsers running. Stop every Firefox/Chromium instance you started
  (`job_kill`, or `kill` on the exact temporary-profile PID).
- Do not restart or edit a maintainer's daily browser profile. Do not kill a
  running browser to get a clean state.
- Keep AMO credentials out of the repository; signing uses the `signing` GitHub
  environment. See `DISTRIBUTING.md`.
