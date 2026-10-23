# C8 Chat — agent notes

Workspace instructions for anyone (human or agent) working in this repo. The
project is a dependency-free MV3 extension for https://www.castleinfinity.com;
there is no build step, only `web-ext` packaging.

## Installing or updating the extension in Zen Browser

Verified on Zen 1.23.3b (Flatpak `app.zen_browser.zen`, Gecko 158) — this is the
whole procedure; nothing below needs guessing.

**1. Zen's real profile path.** Zen runs the `Default (release)` profile, not the
one `profiles.ini` marks `Default=1`:

```
/var/home/dion/.var/app/app.zen_browser.zen/.zen/xucqd4wc.Default (release)
```

Confirm with `[Install2953CB39A2589173] Default=xucqd4wc.Default (release)` in
`profiles.ini`. Never edit add-on files in `6jn6wqqm.Default Profile`; the running
browser does not read it.

**2. Zen is sandboxed to `~/Downloads`.** `flatpak info --show-permissions` shows
`filesystems=xdg-download`, so Zen cannot read this project directory. Stage the
XPI first:

```sh
cp /var/home/dion/projects/c8-extension/dist/c8-chat-1.0.0-firefox.xpi \
   /var/home/dion/Downloads/c8-extension/c8-chat.xpi
```

**3. Unsigned local add-ons need the profile prefs.** `xpinstall.signatures.required`
defaults to `true` in Zen and `user.js` beats defaults, so keep this block in the
profile's `user.js`:

```js
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 14);  // 15 would auto-disable the sideload
```

**4. Hand the XPI to the running browser.** With Zen already open:

```sh
flatpak run app.zen_browser.zen /var/home/dion/Downloads/c8-extension/c8-chat.xpi
```

Zen shows an **Add C8 Chat** dialog ("unverified extension"). That click
is the one step an agent cannot perform — the dialog is browser chrome, not page
content, and there is no automation channel into the Flatpak's UI. Ask the user to
click **Add**; do not claim an install happened before the version below changes.

Do **not** pass `--profile`, `--new-tab`, or a `moz-extension://` URL while Zen is
running: the Flatpak treats it as a second launch and answers "Zen is already
running, but is not responding", which looks like a crash. Open tabs with the
plain URL argument instead, or let the user navigate.

**5. Verify the install from disk** (no browser UI needed):

```sh
python3 - <<'PY'
import json, pathlib
base = pathlib.Path('/var/home/dion/.var/app/app.zen_browser.zen/.zen/xucqd4wc.Default (release)')
a = next(x for x in json.loads((base / 'extensions.json').read_text())['addons']
         if x['id'] == 'c8-chat@dionjones615.github.io')
print(a['version'], a['active'], a['userPermissions']['origins'])
PY
```

`active: true` plus the expected `version` means Zen is running the new build; a
reload of the game tab is enough, Zen does not need a restart for an add-on update.

**6. Prove the panel actually injected.** The panel writes a boot marker to
`chrome.storage.local` under `diag`; Firefox stores it in the profile's extension
IndexedDB, and key names there are stored with every byte +1 (`diag` → `0ejbh`):

```sh
python3 - <<'PY'
import glob, pathlib, time
base = '/var/home/dion/.var/app/app.zen_browser.zen/.zen/xucqd4wc.Default (release)'
for f in glob.glob(base + '/storage/default/moz-extension+++*/idb/*.sqlite'):
    p = pathlib.Path(f)
    print(time.strftime('%H:%M:%S', time.localtime(p.stat().st_mtime)),
          b'0ejbh' in p.read_bytes(), p.name)
PY
```

A `True` with a fresh mtime proves a panel ran in Zen. Get the extension UUID from
`extensions.webextensions.uuids` in the profile's `prefs.js` when a specific
`moz-extension://<uuid>` URL is needed.

## Why the manifest uses required host access

Earlier builds declared Castle Infinity as an `optional_host_permissions` entry and
registered the content scripts at runtime from the popup. In Zen the
`permissions.request()` grant never persisted (`userPermissions.origins` stayed
`[]`), so nothing injected and the panel silently never appeared. The manifest now
declares `host_permissions` and ships the agent (MAIN world, `document_start`) and
panel (isolated, `document_idle`) as static `content_scripts`. Browsers grant
declared host access during installation, so injection needs no click. Do not
"fix" this back into an optional permission gate without re-testing in Zen.

## Package, test, lint

The `browser-extensions` distrobox at `~/areas/dev-envs/browser-extensions` is up and
usable (it carries web-ext, Playwright's Chromium, Firefox + geckodriver + Selenium).
The repository now installs its own tooling:

```sh
npm ci
npm test
npm run lint
npm run package
npm run smoke
```

`npm run check` runs the package/lint/test sequence. The artifact holds
`manifest.json`, `src/`, and `icons/` and nothing else. Do not go back to a hand-built
`web-ext build` unless bootstrapping without `package.json`: `'test/**'` alone leaves
an empty `test/` entry in the zip, which is why the directory is ignored too.

## Installing in Chromium

Chromium cannot load an add-on from this directory: the Flatpak
(`io.github.ungoogled_software.ungoogled_chromium`) exposes `~/Downloads`, `/tmp` and
the desktop, **not** `~/projects`. Stage an unpacked copy where it can see it:

```sh
rm -rf ~/Downloads/c8-extension/chromium && mkdir -p ~/Downloads/c8-extension/chromium
cp -r manifest.json src icons ~/Downloads/c8-extension/chromium/
```

Then `chrome://extensions` → **Developer mode** → **Load unpacked** →
`~/Downloads/c8-extension/chromium`. That click is the one step an agent cannot do;
the id it gets for that path is `bdgdgcmdiojmabdcgkbfiojpppdmgela`, and the install is
verifiable without any UI:

```sh
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home()/'.var/app/io.github.ungoogled_software.ungoogled_chromium/config/chromium/Default/Preferences'
for k, v in (json.loads(p.read_text()).get('extensions', {}).get('settings', {}) or {}).items():
    print(k, '|', v.get('path'))
PY
```

A `c8-chat.crx` beside it can be dragged onto `chrome://extensions` instead. It is
packed from the same staged directory with a key kept next to it
(`c8-chat-chromium.pem`), so the id stays stable across rebuilds:

```sh
chrome --pack-extension=$HOME/Downloads/c8-extension/chromium \
       --pack-extension-key=$HOME/Downloads/c8-extension/c8-chat-chromium.pem
```

## Verifying in Chromium headlessly

No Selenium and no Playwright package needed: headless Chromium plus the DevTools
protocol, driven by Node 22+ (global `WebSocket`). Launch with a throwaway profile so
the user's session is untouched, then navigate and probe:

```sh
$HOME/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome --headless=new --no-sandbox \
  --user-data-dir=$HOME/Downloads/c8-extension/.probe-profile \
  --load-extension=$HOME/Downloads/c8-extension/chromium \
  --remote-debugging-port=9333 about:blank
```

`Page.navigate` to the game, then read the panel out of the shadow root:
`#c8-chat-host` → `shadowRoot.getElementById('panel')`. The Flatpak works the same
way via `flatpak run io.github.ungoogled_software.ungoogled_chromium …`.

To exercise rendering that needs game data, load a copy whose manifest keeps only the
panel's content script and impersonate the agent from the page:
`window.postMessage({__c8_companion__:1, k:'reply', id, ok:true, value})`, so
`readDir`/`readBytes` can answer with a synthetic BMP. That is how the schtick-head
path was checked in Chromium — it renders, including when the art arrives after the
line.

## Verifying in Firefox

The `browser-extensions` distrobox carries Firefox, geckodriver and Selenium, so a
real Firefox content script can be driven headlessly from the host. Serve a page,
load a copy of the extension whose manifest matches it, and drive it with Selenium:

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
Chromium probe above; that is how the head-art path was proven on Firefox 158.

**Do not hand a typed array to a canvas from a content script.** In the isolated
world `putImageData(new ImageData(ownUint8ClampedArray, w, h))` throws
`InvalidStateError: failed to extract Uint8ClampedArray`, and `img.data.set(ownArray)`
throws `Permission denied to access object`; only element-wise assignment into the
context's own `createImageData(...).data` works. That single constraint is why the
head PNG is written by a pixel loop and not by `.set()` or an OffscreenCanvas.

## Reading the panel's diagnostics

The panel writes `chrome.storage.local` every 5 s: `diagJson` (counts, actor samples,
last line, errors) plus base64 blobs. Firefox stores it in the profile's extension
IndexedDB with byte-shifted keys (`diag` → `0ejbh`, `diagJson` → `0ejbhKtpo`). The
value is a **Snappy stream** (LEB128 length, then literal/copy tags) holding the
JSON as **UTF-16LE**, so eyeballing fragments reads only the literal runs. Decode
it properly instead — a ~40-line Snappy block decoder is enough, then
`bytes.decode('utf-16-le')` from the `{"build"` offset. That is how `headArtPath`,
`headAsk` and the actor samples were read back from a live Zen session. Chromium stores it under
`<profile>/Local Extension Settings/<id>/` as a LevelDB log whose value is a **JSON
string literal** — parse from `"` after the key to the closing unescaped quote, then
`json.loads` twice (literal, then the record).

That is where the "missing heads" question was answered: the record showed
`head: 1` for our own actor and `head: null` for two other players, so the wire had
not sent their schtick parts. Not a rendering fault.

## Reporting rules for this repo

- Never say a browser was fixed or verified unless a check above actually ran;
  state which one ran and its output.
- Do not leave browsers running. Stop every Firefox/Chromium instance you started
  (`job_kill`, or `kill` on the exact temporary-profile PID) and confirm the user's
  own Zen process is untouched before finishing.
- Zen is the user's daily browser: never restart it, never edit its profile files
  by hand, and never kill it to get a clean state.
