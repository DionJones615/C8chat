/* C8 Chat - MAIN-world agent.
 *
 * Injected at document_start into the page's own JS context, because everything
 * worth touching (window.Module, window.FS, window.c8SetControlState and the
 * game's WebSocket) lives there and is invisible from an isolated world.
 *
 * It does three things and nothing else:
 *   1. tees the game's binary WebSocket traffic (Emscripten SOCKFS tunnels the
 *      whole game protocol through a plain browser WebSocket),
 *   2. taps the WASM -> shell UI state callback,
 *   3. exposes key/text injection, which is how the site's own on-screen
 *      controls and mobile keyboard already drive the game.
 *
 * Everything crosses into the extension through window.postMessage. The account
 * key is scrubbed at this boundary and never leaves the page world.
 */
(function () {
  'use strict';

  var CH = '__c8_chat__';
  var CH_LEGACY = '__c8_companion__';    // the bridge name before the rename

  // A page can retain the MAIN-world agent after an extension reload. Make
  // reinjection idempotent so each command and key reaches the game once.
  if (window.__c8ChatAgentInstalled) return;
  window.__c8ChatAgentInstalled = true;

  // A retained agent from before the rename still owns the page's WebSocket
  // wrapper and speaks the legacy bridge name. Re-wrapping on top of it would
  // lose the live socket, so relay both ways instead: the panel's commands go
  // out under the legacy name, and the retained agent's events come back under
  // this one. One rename's worth of shim; drop it once no page can still run
  // the old build.
  if (window.__c8CompanionAgentInstalled) {
    window.addEventListener('message', function (ev) {
      if (ev.source !== null && ev.source !== window) return;
      if (ev.origin !== window.location.origin) return;
      var d = ev.data;
      if (!d || (d[CH] !== 1 && d[CH_LEGACY] !== 1)) return;
      if (d.k === 'cmd' && d[CH] === 1 && d[CH_LEGACY] !== 1) {
        var out = {};
        for (var k in d) out[k] = d[k];
        out[CH_LEGACY] = 1;
        post(out);
      } else if (d.k !== 'cmd' && d[CH_LEGACY] === 1 && d[CH] !== 1) {
        var inc = {};
        for (var n in d) inc[n] = d[n];
        inc[CH] = 1;
        post(inc);
      }
    });
    return;
  }

  var Proto = window.C8Proto;

  function post(msg) {
    msg[CH] = 1;
    try { window.postMessage(msg, window.location.origin); } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- secrets */

  var cachedSecret = null;
  function secret() {
    if (cachedSecret !== null) return cachedSecret;
    cachedSecret = '';
    try {
      var a = window.Module && window.Module.arguments;
      if (a) {
        var i = a.indexOf('-vorticopass');
        if (i >= 0 && i + 1 < a.length) cachedSecret = String(a[i + 1]);
      }
      if (!cachedSecret) cachedSecret = localStorage.getItem('c8.secret') || '';
    } catch (e) { /* ignore */ }
    return cachedSecret;
  }

  /** Remove the account key from anything about to be forwarded or stored. */
  function scrub(s) {
    return Proto.redact(s, secret());
  }

  /* ------------------------------------------------------------- WebSocket */

  var sockets = [];
  var frames = 0;
  var lastSectorTarget = 0;

  function targetOf(url) {
    var m = /[?&]target=(\d+)/.exec(String(url));
    return m ? Number(m[1]) : 0;
  }

  /* Raw bytes are the Debug pane's, not every frame's.

     `hex` is three characters of string per byte of traffic and the whole frame is
     structured-cloned into the isolated world, so building it for every keepalive
     and position update is the most expensive thing this agent does — for frames
     the panel then throws away. They are kept for the opening frames (the first
     speech and send shapes are what pin a decoder down), for outbound speech until
     a few balloons have been seen, and for everything while capture is on. */
  var RAW_WINDOW = 40;
  var rawSeen = 0;
  var waddaKept = 0;
  var actorKept = 0;
  var captureOn = false;

  var WDDA = [0x57, 0x44, 0x44, 0x41];

  /** Does this payload carry the speech verb? A byte scan, not a hex string. */
  function hasWadda(p) {
    for (var i = 0; i + WDDA.length <= p.length; i++) {
      var hit = true;
      for (var k = 0; k < WDDA.length; k++) if (p[i + k] !== WDDA[k]) { hit = false; break; }
      if (hit) return true;
    }
    return false;
  }

  function describe(dir, idx, data) {
    var sock = sockets[idx] || {};
    if (typeof data === 'string') {
      return { dir: dir, target: sock.target, t: Date.now(), name: 'text', text: scrub(data.slice(0, 400)) };
    }
    var u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    var msgs = Proto.splitFrames(u8);
    // One WebSocket frame usually carries several protocol messages; report the
    // first (the interesting one) and summarise the rest.
    var head = msgs[0] || { name: 'empty', type: -1, payload: u8 };
    var decoded = [];
    for (var i = 0; i < msgs.length; i++) {
      var d = Proto.decode(msgs[i].payload, msgs[i].type);
      if (d) decoded.push(d);
    }

    var wadda = false;
    if (dir === 'out') {
      for (var j = 0; j < msgs.length && !wadda; j++) wadda = hasWadda(msgs[j].payload);
    }
    var actors = false;
    for (var m = 0; m < decoded.length && !actors; m++) actors = decoded[m].kind === 'actors';
    var raw = captureOn || rawSeen < RAW_WINDOW || (wadda && waddaKept < 3) ||
      (actors && actorKept < 6);
    if (raw) {
      rawSeen++;
      if (wadda) waddaKept++;
      if (actors) actorKept++;
    }
    var strings = [];
    if (raw) {
      for (var k = 0; k < msgs.length; k++) strings = strings.concat(Proto.printable(msgs[k].payload));
    }

    return {
      dir: dir,
      target: sock.target,
      t: Date.now(),
      channel: head.channelName,
      name: head.name,
      type: head.type,
      n: u8.length,
      count: msgs.length,
      // A capture export is only worth having if it holds whole frames: the room
      // roster arrives as one ~8 KB frame, and 4 KB cut it off before the records of
      // everyone but us. Diagnostics only, so the cap rises only while capturing.
      hex: raw ? scrub(Proto.hex(u8, captureOn ? 65536 : 4096)) : undefined,
      strings: raw ? strings.map(scrub) : undefined,
      // Everything the decoder produced is forwarded, with its strings scrubbed.
      // Re-projecting through a field whitelist silently dropped fields the panel
      // needs (notably the speech actor tag, which keys the per-speaker buffers).
      decoded: decoded.length ? decoded.map(function (d) {
        var o = {};
        for (var k in d) o[k] = typeof d[k] === 'string' ? scrub(d[k]) : d[k];
        return o;
      }) : undefined,
      sectors: head.type === 0x14 ? Proto.sectorEntries(head.payload) : undefined
    };
  }

  var sendHook = false;      // a send has actually gone through the tap
  var stateTapInstalled = false;

  function installWebSocketTee() {
    var Orig = window.WebSocket;
    if (!Orig || Orig.__c8wrapped) return;

    var originalSend = Orig.prototype.send;
    var prototypeTapInstalled = false;
    function prototypeTap(data) {
      sendHook = true;
      var index = -1;
      for (var i = sockets.length - 1; i >= 0; i--) {
        if (sockets[i].sock === this) { index = i; break; }
      }
      if (index >= 0) {
        frames++;
        try { post({ k: 'frame', frame: describe('out', index, data) }); } catch (e) { /* ignore */ }
      }
      return originalSend.apply(this, arguments);
    }
    try {
      Object.defineProperty(Orig.prototype, 'send', {
        configurable: true, writable: true, value: prototypeTap
      });
      prototypeTapInstalled = Orig.prototype.send === prototypeTap;
    } catch (e) { /* per-socket wrapping below */ }

    function C8Socket(url, protocols) {
      var sock = new Orig(url, protocols);
      var idx = sockets.length;
      var target = targetOf(url);
      sockets.push({ url: String(url), target: target, opened: Date.now(), sock: sock });

      if (target && target !== 1776 && target !== lastSectorTarget) {
        lastSectorTarget = target;
        post({ k: 'room', target: target });
      }

      sock.addEventListener('message', function (ev) {
        frames++;
        try { post({ k: 'frame', frame: describe('in', idx, ev.data) }); } catch (e) { /* ignore */ }
      });
      function dropped() {
        if (target && target !== 1776) post({ k: 'sock', ev: 'closed', target: target });
      }
      sock.addEventListener('close', dropped);
      sock.addEventListener('error', dropped);

      if (!prototypeTapInstalled) {
        try {
          var nativeSend = sock.send;
          function tapSend(data) {
            sendHook = true;
            frames++;
            try { post({ k: 'frame', frame: describe('out', idx, data) }); } catch (e) { /* ignore */ }
            return nativeSend.apply(sock, arguments);
          }
          Object.defineProperty(sock, 'send', {
            configurable: true, writable: true, value: tapSend
          });
          if (sock.send !== tapSend) throw new Error('socket send is not writable');
        } catch (e) { /* this socket shape refuses it; the prototype tap still sees sends */ }
      }
      return sock;
    }

    C8Socket.prototype = Orig.prototype;
    C8Socket.__c8wrapped = true;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k, n) { C8Socket[k] = n; });
    window.WebSocket = C8Socket;
  }

  /* ------------------------------------------------- WASM -> shell UI state */

  var LABELS = ['', 'Clear', 'Send', 'My List', 'Search', 'Find', 'Names', 'Update', 'Tuner', 'Tune',
    'Drop', 'Switch', 'Stash', 'Quit', 'My Room', 'Security', 'Continue', 'Cancel', 'New', 'Answer',
    'Trash It', 'Mark', 'Choose', 'Go Back'];

  var lastState = null;
  function decodeState(packed) {
    var p = packed >>> 0;
    return {
      packed: p,
      inStella: !!(p & 1),
      a: LABELS[(p >>> 8) & 255] || '',
      b: LABELS[(p >>> 16) & 255] || '',
      c: LABELS[(p >>> 24) & 255] || '',
      en: { a: !!(p & 4), b: !!(p & 8), c: !!(p & 16), stella: !!(p & 32) }
    };
  }

  function installStateTap() {
    if (stateTapInstalled) return;

    var real = null;
    function wrapper(packed) {
      try {
        lastState = decodeState(packed);
        post({ k: 'state', state: lastState });
      } catch (e) { /* ignore */ }
      return real ? real.apply(this, arguments) : undefined;
    }

    try {
      if (typeof window.c8SetControlState === 'function') real = window.c8SetControlState;
      Object.defineProperty(window, 'c8SetControlState', {
        configurable: true,
        get: function () { return wrapper; },
        set: function (fn) { real = fn; }
      });
      window.__c8stateTapError = null;
      window.__c8stateTapped = true;
      stateTapInstalled = true;
    } catch (e) {
      // Do not poison the sentinel; readiness polling retries installation.
      window.__c8stateTapError = String(e);
    }
  }

  /* ------------------------------------------------------------- scancodes */

  var SC = { ' ': 44, "'": 52, ',': 54, '-': 45, '.': 55, '/': 56, ';': 51, '=': 46, '[': 47, ']': 48, '\\': 49, '`': 53 };
  var i;
  for (i = 0; i < 26; i++) SC[String.fromCharCode(97 + i)] = 4 + i;
  for (i = 1; i <= 9; i++) SC['' + i] = 29 + i;
  SC['0'] = 39;
  var SHIFT = { '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };
  var NAMED = { Enter: 40, Backspace: 42, Tab: 43, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78, Insert: 73, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82 };

  function mapKey(key) {
    if (NAMED[key] != null) return { sc: NAMED[key], shift: 0, text: null };
    if (typeof key !== 'string' || key.length !== 1) return null;
    var base = SHIFT[key] || key.toLowerCase();
    var sc = SC[base];
    if (sc == null) return null;
    return { sc: sc, shift: key === base ? 0 : 1, text: key };
  }

  function module() { return window.Module; }
  function injectKey(sc, down) {
    var M = module();
    if (!M || !M._c8_inject_key) return false;
    M._c8_inject_key(sc, down ? 1 : 0);
    return true;
  }
  function injectText(str) {
    var M = module();
    if (!M || !M._c8_inject_text_key) return 0;
    var n = 0;
    for (var j = 0; j < str.length; j++) {
      var m = mapKey(str[j]);
      if (!m) continue;
      M._c8_inject_text_key(m.sc, m.shift);
      n++;
    }
    return n;
  }

  /* ------------------------------------------------------------- recording */

  var recording = false;

  /**
   * True when the event came from the extension's own UI. Our recorder listens
   * at window-capture, which fires before the panel's shadow-boundary guard, so
   * without this a routine would capture the user typing in the chat box and
   * then replay those keystrokes into the game.
   */
  function fromExtensionUi(ev) {
    var host = document.getElementById('c8-chat-host');
    if (!host) return false;
    if (ev.target === host) return true; // shadow events are retargeted to the host
    var path = ev.composedPath ? ev.composedPath() : null;
    return !!path && path.indexOf(host) !== -1;
  }

  function onKey(ev, down) {
    if (!recording) return;
    if (fromExtensionUi(ev)) return;
    var m = mapKey(ev.key);
    if (!m) return;
    post({ k: 'key', t: Math.round(performance.now()), sc: m.sc, down: down, text: m.text });
  }

  /* ------------------------------------------------------------------- boot */

  installWebSocketTee();
  installStateTap();

  window.addEventListener('keydown', function (e) { onKey(e, true); }, true);
  window.addEventListener('keyup', function (e) { onKey(e, false); }, true);

  function status() {
    var M = module();
    return {
      // Readiness is the hook the panel actually needs. window.c8RuntimeReady is a
      // page flag that stayed false on a live client even with the WASM up, and a
      // status reply carrying that false disabled every send with "still loading".
      ready: !!(M && M._c8_inject_key),
      runtimeReady: !!window.c8RuntimeReady,
      hasModule: !!M,
      canInject: !!(M && M._c8_inject_key),
      canType: !!(M && M._c8_inject_text_key),
      hasFs: !!window.FS,
      sockets: sockets.length,
      frames: frames,
      sendHook: sendHook,
      stateTapInstalled: stateTapInstalled,
      stateTapError: window.__c8stateTapError || null,
      state: lastState,
      user: (function () {
        try {
          var a = M && M.arguments;
          var i = a ? a.indexOf('-vorticouser') : -1;
          return i >= 0 ? a[i + 1] : null;
        } catch (e) { return null; }
      })()
    };
  }

  function readText(path) {
    var FS = window.FS;
    if (!FS) return null;
    try {
      return new TextDecoder().decode(FS.readFile(path));
    } catch (e) {
      return null;
    }
  }

  /**
   * The game's art is in the same preloaded package as connect.dat, so it is
   * already in the FS and needs no request of its own. Bytes cross as a plain
   * array: it survives the postMessage clone and needs no base64 on either side.
   */
  function readBytes(path) {
    var FS = window.FS;
    if (!FS) return null;
    try {
      return Array.prototype.slice.call(FS.readFile(path));
    } catch (e) {
      return null;
    }
  }

  /** Directory listing, so the art tree is walked rather than hardcoded. */
  function readDir(path) {
    var FS = window.FS;
    if (!FS || !FS.readdir) return null;
    try {
      return Array.prototype.slice.call(FS.readdir(path))
        .filter(function (n) { return n !== '.' && n !== '..'; });
    } catch (e) {
      return null;
    }
  }

  /* ---------------------------------------------------------------- speech */

  /**
   * Public room chat. There is no frame to synthesise here: you raise a speech
   * balloon by typing into the game itself, which is exactly what the site's own
   * mobile keyboard does. So feed one character at a time through the game's
   * text-input API and commit with Enter (scancode 40), mirroring the site's
   * `#kbd-proxy` handler.
   */
  var PRESS_MS = 60;             // how long a synthesised key is held down
  var SAY_DELAY = 130;
  var SAY_MAX = 120;
  var sayInFlight = false;

  function sayText(text, commit) {
    text = String(text == null ? '' : text);
    if (!text.trim()) return { ok: false, typed: 0, error: 'Enter a message first.' };
    if (text.length > SAY_MAX) {
      return { ok: false, typed: 0, error: 'Room messages are limited to ' + SAY_MAX + ' characters.' };
    }
    if (sayInFlight) {
      return { ok: false, typed: 0, error: 'A room message is already being sent. Please wait.' };
    }
    var M = module();
    if (!M || typeof M._c8_inject_text_key !== 'function' || typeof M._c8_inject_key !== 'function') {
      return { ok: false, typed: 0, error: 'The game is still loading; your message was not sent.' };
    }
    // The game input bridge is a US-keyboard mapping, not a Unicode text API.
    // Reject the entire string before touching game state so nothing is dropped
    // or partially transmitted without the user knowing.
    for (var j = 0; j < text.length; j++) {
      if (!mapKey(text.charAt(j))) {
        return { ok: false, typed: 0, error: 'Room chat supports printable US-ASCII characters only.' };
      }
    }

    sayInFlight = true;
    return new Promise(function (resolve) {
      var i = 0, typed = 0;
      function finish(result) {
        sayInFlight = false;
        resolve(result);
      }
      function step() {
        if (i >= text.length) {
          if (commit) {
            try {
              if (!injectKey(40, true)) {
                finish({ ok: false, typed: typed, error: 'The game stopped accepting input before the message was sent.' });
                return;
              }
              setTimeout(function () { injectKey(40, false); }, 60);
            } catch (e) {
              finish({ ok: false, typed: typed, error: String(e) });
              return;
            }
          }
          finish({ ok: true, typed: typed });
          return;
        }
        try {
          var count = injectText(text.charAt(i));
          if (count !== 1) {
            finish({ ok: false, typed: typed, error: 'The game stopped accepting input before the message was sent.' });
            return;
          }
          typed += count;
          i++;
        } catch (e) {
          finish({ ok: false, typed: typed, error: String(e) });
          return;
        }
        setTimeout(step, SAY_DELAY);
      }
      step();
    });
  }

  var CMDS = {
    status: status,
    injectKey: function (a) { return injectKey(a.sc, a.down); },
    // Down and up in the same tick is a press the client can miss: it samples the
    // keyboard once a frame, so the key is held for a moment the way a hand would.
    // (The Enter commit in sayText learned the same thing.) A missed press is how a
    // face ask went out three times and the server never re-sent the actor record.
    press: function (a) {
      if (!injectKey(a.sc, true)) return false;
      setTimeout(function () { injectKey(a.sc, false); }, PRESS_MS);
      return true;
    },
    injectText: function (a) { return injectText(a.text); },
    say: function (a) { return sayText(a.text, a.commit !== false); },
    clearKeys: function () {
      var M = module();
      if (M && M._c8_clear_key_state) { M._c8_clear_key_state(); return true; }
      return false;
    },
    record: function (a) { recording = !!a.on; return recording; },
    // The Debug pane's capture switch: raw bytes are built in the page, so this is
    // what decides whether they are built at all.
    capture: function (a) { captureOn = !!a.on; return captureOn; },
    readText: function (a) { return readText(a.path); },
    readBytes: function (a) { return readBytes(a.path); },
    readDir: function (a) { return readDir(a.path); },
    sendMessage: function (a) { return sendMessage(a.to, a.text); },
    target: function () { return window.location.href; },
    // The page's own canvas fit, re-run on demand. Its ResizeObserver only reports
    // size, so a side switch that leaves #stage the same width (dock left -> dock
    // right) would keep the WASM screen at its old x until this runs.
    layout: function () {
      if (typeof window.c8LayoutGameCanvas === 'function') {
        window.c8LayoutGameCanvas();
        return true;
      }
      return false;
    }
  };

  /* ------------------------------------------------------------ direct send */

  // The one place the extension writes a protocol frame instead of driving the
  // game's UI. 0x19 is byte-for-byte what the client itself emits from the
  // StellaVision compose screen (verified by capturing both), so the server
  // parses it identically; the codec enforces the client's own length limits.
  var MAX_TEXT = 180;

  function gameSocket() {
    for (var i = sockets.length - 1; i >= 0; i--) {
      // 1776 is the metaserver; the sector server is anything else
      if (sockets[i].target && sockets[i].target !== 1776) return sockets[i].sock;
    }
    return null;
  }

  function sendMessage(to, body) {
    to = String(to == null ? '' : to);
    body = String(body == null ? '' : body);
    if (!to || !body) return { ok: false, error: 'Choose a recipient and enter a message.' };
    if (!Proto.printableAscii(to) || !Proto.printableAscii(body)) {
      return { ok: false, error: 'Private messages support printable ASCII characters only.' };
    }
    if (to.length > Proto.NAME_FIELD - 1) {
      return { ok: false, error: 'Recipient names must be ' + (Proto.NAME_FIELD - 1) + ' characters or fewer.' };
    }
    if (body.length > MAX_TEXT) return { ok: false, error: 'Private messages are limited to ' + MAX_TEXT + ' characters.' };
    var sock = gameSocket();
    if (!sock || sock.readyState !== 1) return { ok: false, error: 'not connected to a sector' };
    var frame = Proto.buildMessage(to, body, MAX_TEXT);
    if (!frame) return { ok: false, error: 'The message could not be encoded without changing it.' };
    try {
      sock.send(frame);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  window.addEventListener('message', function (ev) {
    // Firefox reports null for postMessage events crossing an extension/content-script boundary.
    if (ev.source !== null && ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || d[CH] !== 1 || d.k !== 'cmd') return;
    var fn = CMDS[d.cmd];
    if (!fn) { post({ k: 'reply', id: d.id, ok: false, value: 'unknown command' }); return; }
    var value;
    try {
      value = fn(d.args || {});
    } catch (e) {
      post({ k: 'reply', id: d.id, ok: false, value: String(e) });
      return;
    }
    // Some commands (typing a message out) take time; reply when they settle.
    if (value && typeof value.then === 'function') {
      value.then(
        function (v) { post({ k: 'reply', id: d.id, ok: true, value: v }); },
        function (e) { post({ k: 'reply', id: d.id, ok: false, value: String(e) }); }
      );
      return;
    }
    post({ k: 'reply', id: d.id, ok: true, value: value });
  });


  /* ------------------------------------------------------------ diagnostics */

  // The page's own console is where most of its failures show up, and a content
  // script cannot catch them. Mirror the last few distinct error lines to the
  // panel so its diagnostics record can name what a reader of the console sees.
  // Wrapped, never replaced: the page's output still reaches the real console.
  var pageErrors = [];
  var lastConsolePost = 0;
  function noteConsole(text) {
    try {
      text = String(text == null ? '' : text).replace(/\s+/g, ' ').slice(0, 180);
      if (!text) return;
      var found = false;
      for (var i = 0; i < pageErrors.length; i++) {
        if (pageErrors[i].text === text) { pageErrors[i].n++; found = true; break; }
      }
      if (!found && pageErrors.length < 8) pageErrors.push({ text: text, n: 1 });
      var now = Date.now();
      if (now - lastConsolePost < 1000) return;   // one update a second at most
      lastConsolePost = now;
      post({ k: 'console', errors: pageErrors.slice() });
    } catch (e) { /* diagnostics must never break the page */ }
  }

  try {
    var realConsoleError = console.error;
    console.error = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          parts.push(typeof a === 'string' ? a : (a && a.message) || String(a));
        }
        noteConsole(parts.join(' '));
      } catch (e) { /* ignore */ }
      return realConsoleError.apply(console, arguments);
    };
  } catch (e) { /* ignore */ }

  window.addEventListener('error', function (ev) {
    noteConsole((ev && (ev.message || (ev.error && ev.error.message))) || 'script error');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    noteConsole('unhandled rejection: ' + ((r && (r.message || r)) || ''));
  });

  // The WASM runtime initialises long after document_start; announce readiness
  // once Module appears so the panel can enable the game-dependent features.
  var announced = false;
  var timer = setInterval(function () {
    var M = module();
    if (!stateTapInstalled && M && M._c8_inject_key) installStateTap();
    if (!announced && M && M._c8_inject_key && window.c8SetControlState) {
      announced = true;
      clearInterval(timer);
      post({ k: 'console', errors: pageErrors.slice() });   // anything logged before the panel ran
      post({ k: 'ready', status: status() });
    }
  }, 500);
  setTimeout(function () { clearInterval(timer); }, 300000);
})();
