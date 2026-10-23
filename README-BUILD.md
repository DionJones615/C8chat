# Building C8 Chat

C8 Chat has **no build step**. The files in `manifest.json`, `src/`, and `icons/`
are the extension that is uploaded to the stores. There is no transpiler, bundler,
minifier, or generated code.

## Reproduce the package

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
npm test
npm run lint
npm run package
```

`npm run package` validates the manifest and writes:

- `dist/c8-chat-<version>-chrome.zip`
- `dist/c8-chat-<version>-firefox.xpi`
- `dist/c8-chat-<version>-source.zip` (this source archive)
- `dist/SHA256SUMS`

The extension archives contain only `manifest.json`, `src/`, and `icons/`.
The source archive contains the same files plus tests, scripts, and documentation.

## Notes for reviewers

- No remote code is loaded or executed.
- The extension only runs on `https://www.castleinfinity.com/*`.
- The agent content script wraps the page's own `WebSocket` to observe the game's
  existing traffic; it does not redirect it.
- The panel stores its chat log and settings locally in `chrome.storage.local`.
  Nothing is transmitted to the developer or a third party.
- The game's session key is read in memory only to redact it from diagnostic
  data; it is never stored or transmitted.
- `web-ext lint --source-dir dist/unpacked --warnings-as-errors` passes.
