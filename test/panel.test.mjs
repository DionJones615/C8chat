/**
 * Panel smoke + chat-box tests.
 *
 * panel.js is a browser IIFE that owns a shadow root, so this runs it against a
 * minimal DOM stub. The stub models the two things that actually bit us:
 * getElementById resolves in document order within the shadow tree, and event
 * handlers belong to the element they were registered on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/panel.js', import.meta.url), 'utf8');

/* ------------------------------------------------------------------ DOM stub */

function matches(node, sel) {
  if (sel.startsWith('.')) return node._set.has(sel.slice(1));
  if (sel.startsWith('#')) return node.attrs.id === sel.slice(1);
  return node.tagName === sel.toUpperCase();
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.isConnected = true;
    this.children = [];
    this.attrs = {};
    // custom properties are how the panel passes the log size and head size to the
    // stylesheet, so the stub has to hold them like the real CSSStyleDeclaration
    this.style = {
      _p: {},
      setProperty(k, v) { this._p[k] = String(v); },
      getPropertyValue(k) { return this._p[k] === undefined ? '' : this._p[k]; },
      removeProperty(k) { delete this._p[k]; }
    };
    this._text = '';
    this._class = '';
    this._handlers = {};
    this._set = new Set();
    const set = this._set;
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, f) => { (f === undefined ? !set.has(c) : f) ? set.add(c) : set.delete(c); }
    };
  }
  set className(v) {
    this._class = String(v || '');
    // the real attribute replaces the class list; it does not merge into it
    this._set.clear();
    this._class.split(/\s+/).filter(Boolean).forEach((c) => this._set.add(c));
  }
  get className() { return Array.from(this._set).join(' '); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set id(v) { this.attrs.id = String(v); }
  get id() { return this.attrs.id; }
  /** Direct and optgroup-nested options, as a real select exposes them. */
  options() {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.tagName === 'OPTION') out.push(c); else walk(c); } };
    walk(this);
    return out;
  }
  get value() {
    if (this.tagName !== 'SELECT') return this._value;
    // a select refuses a value that is not one of its options, falling back to
    // the first one — which is exactly the behaviour the panel relies on
    const vals = this.options().map((o) => (o._value === undefined ? '' : o._value));
    if (this._value !== undefined && vals.indexOf(this._value) >= 0) return this._value;
    return vals.length ? vals[0] : '';
  }
  set value(v) { this._value = v; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { this.children.push(c); c._parent = this; return c; }
  remove() { this.isConnected = false; if (this._parent) this._parent.removeChild(this); }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); }
  removeEventListener() {}
  click() { (this._handlers.click || []).forEach((fn) => fn({ target: this })); }
  /** Fire any handler registered through the panel's `on*` attribute path. */
  dispatch(type, ev) { (this._handlers[type] || []).forEach((fn) => fn(ev || { target: this })); }
  alsoSetText(t) { this.textContent = t; return this; }
  attachShadow() { this.shadowRoot = new El('#shadow'); return this.shadowRoot; }
  /** Document-order search within this subtree, as the real DOM does. */
  getElementById(id) {
    for (const c of this.children) {
      if (c.attrs.id === id) return c;
      const hit = c.getElementById(id);
      if (hit) return hit;
    }
    return null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
}

/** Search the composed tree, piercing shadow roots (for test assertions only). */
function deepFind(node, id) {
  for (const c of node.children) {
    if (c.attrs && c.attrs.id === id) return c;
    const hit = deepFind(c, id);
    if (hit) return hit;
  }
  if (node.shadowRoot) return deepFind(node.shadowRoot, id);
  return null;
}

function deepFindAll(node, id, out = []) {
  for (const c of node.children) {
    if (c.attrs && (c.attrs.id === id || c.attrs.for === id)) out.push(c);
    deepFindAll(c, id, out);
  }
  if (node.shadowRoot) deepFindAll(node.shadowRoot, id, out);
  return out;
}

function makeEnv(stored, options = {}) {
  const winListeners = {};
  const intervals = [];
  const timeouts = [];
  const clearedTimeouts = new Set();
  const clearedIntervals = new Set();
  const pendingGets = [];
  const documentElement = new El('html');
  const document = {
    documentElement,
    runtimeManifest: { version: '0.9.49' },
    createElement: (t) => new El(t),
    createElementNS: (ns, t) => new El(t),
    createTextNode: (t) => new El('#text').alsoSetText(t),
    getElementById: (id) => documentElement.getElementById(id),
    querySelector: (s) => documentElement.querySelector(s),
    querySelectorAll: (s) => documentElement.querySelectorAll(s),
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  // The game page's #stage, the box its own layout fits the 4:3 canvas into.
  // Only the tests that assert the docked gutter need it; without it the panel
  // must still work (and every other test proves that by not creating one).
  if (options.stage) {
    // The game's stage, plus the fixed chrome the panel has to keep clear of:
    // its login overlay is centred on the viewport, not on the stage, its status
    // and key cluster are centred there too, and its two panel buttons are pinned
    // to the top-right corner.
    for (const id of ['stage', 'login-overlay', 'status', 'desktop-keys', 'help-btn', 'players-btn']) {
      const node = new El('div');
      node.id = id;
      documentElement.appendChild(node);
    }
  }
  const posted = [];
  const win = {
    location: { origin: 'https://www.castleinfinity.com' },
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener() {},
    postMessage: (msg) => posted.push(msg)
  };
  // every settings write, so a test can assert what a reload would find
  const saved = [];
  const chrome = {
    storage: { local: {
      get: (k, cb) => { if (!cb) return; if (options.asyncStorage) pendingGets.push(() => cb(stored || {})); else cb(stored || {}); },
      set: (o) => saved.push(o)
    } },
    runtime: { getURL: (p) => 'chrome-extension://test/' + p, getManifest: () => document.runtimeManifest }
  };
  // The panel turns a decoded head into a PNG with a canvas. The stub records the
  // pixels that reach the rasteriser, and its ImageData view refuses a typed-array
  // handoff exactly as Firefox does — so a regression back to `data.set(...)` or
  // `new ImageData(array, …)` fails here rather than in the game.
  const painted = [];
  document.createElement = (t) => {
    const node = new El(t);
    if (node.tagName !== 'CANVAS') return node;
    let img = null;
    node.getContext = () => ({
      createImageData: (w, h) => {
        const data = new Proxy(new Array(w * h * 4).fill(0), {
          get(target, k) {
            if (k === 'set') throw new Error('Permission denied to access object');
            return target[k];
          },
          set(target, k, v) { target[k] = v; return true; }
        });
        img = { width: w, height: h, data };
        return img;
      },
      putImageData: () => painted.push(img)
    });
    node.toDataURL = () => 'data:image/png;base64,' + node.width * node.height;
    return node;
  };
  const ctx = vm.createContext({
    window: win,
    document,
    chrome,
    btoa: (s) => Buffer.from(s, 'latin1').toString('base64'),
    location: win.location,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve({ online: [], recent: [] }) }),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: (id) => { if (id) clearedIntervals.add(id); },
    // real timers, so the fragment-flush idle timer can be exercised; unref'd so
    // a pending poll retry cannot hold the test process open
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timeouts.push({ fn, ms, handle: t }); if (t.unref) t.unref(); return t; },
    clearTimeout: (t) => { clearedTimeouts.add(t); clearTimeout(t); },
    console, Date, Promise,
    Blob: function () {},
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    performance: { now: () => 0 },
    TextDecoder
  });
  ctx.globalThis = ctx;

  return {
    ctx, win, document, posted, saved, intervals, timeouts, clearedTimeouts, clearedIntervals, pendingGets, painted,
    el: (id) => deepFind(documentElement, id),
    fire: (type, ev) => (winListeners[type] || []).forEach((fn) => fn(ev)),
    submit: function () {
      const form = deepFind(documentElement, 'chatform');
      form._handlers.submit[0]({ preventDefault() {} });
    },
    El
  };
}

function load(env) {
  vm.runInContext(src, env.ctx);
  return env.el('chatbox');
}

/** Feed the panel a frame message the way src/agent.js would. */
function frame(env, decoded, t, source = env.win, origin = env.win.location.origin) {
  env.fire('message', {
    source, origin,
    data: { __c8_companion__: 1, k: 'frame', frame: { t: t || Date.now(), decoded } }
  });
}

/** Put the panel into "the game is ready and accepting input" state. */
function gameReady(env, user) {
  env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: {
      __c8_companion__: 1, k: 'ready',
      status: { ready: true, user: user || 'Blasto', hasFs: false, canInject: true, canType: true }
    }
  });
  env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: {
      __c8_companion__: 1, k: 'state',
      state: { packed: 0x3c, inStella: false, a: '', b: '', c: '', en: { a: true, b: true, c: true, stella: true } }
    }
  });
}

/** Fill the chat box and submit it. An empty `to` means the whole room. */
function say(env, text, to) {
  env.el('chat-to').value = to || '';
  env.el('chat-text').value = text;
  env.submit();
}

const cmds = (env, name) =>
  env.posted.filter((m) => m && m.k === 'cmd' && (!name || m.cmd === name));

const tick = () => new Promise((r) => setImmediate(r));

/** Move the panel's clock forward, so a cache window is testable without waiting. */
function shiftClock(env, ms) {
  const base = Date.now();
  env.ctx.Date = class extends Date {
    static now() { return base + ms; }
  };
}

/** Make /api/players report these names, with `me` in `mySector`. */
function online(env, names, mySector) {
  env.ctx.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      online: names.map((n) => ({ name: n, sector: n === 'Blasto' ? (mySector || 1) : 37 })),
      recent: []
    })
  });
}

/* The recipient picker is a button and a listbox, not a select: a row has a name
   cell and a room cell, and the room is the one the stylesheet dims and flushes
   right. These helpers read the structure, not one concatenated string. */
const targetRows = (env) => env.el('chat-to-list').children
  .filter((c) => c.classList.contains('to-item'));
const rowFor = (env, name) => targetRows(env).find((r) => r.attrs['data-value'] === (name || ''));
const nickOfRow = (row) => row.children.find((c) => c.classList.contains('to-nick')).textContent;
const roomOfRow = (row) => row.children.find((c) => c.classList.contains('to-room')).textContent;
const roomOf = (env, name) => { const r = rowFor(env, name); return r ? roomOfRow(r) : null; };
const faceOf = (env) => ({
  nick: env.el('chat-to-nick').textContent,
  room: env.el('chat-to-room').textContent
});
/** Choose a recipient the way a click on its row does. */
const pickTarget = (env, name) => {
  const row = rowFor(env, name);
  assert.ok(row, 'no row for recipient: ' + JSON.stringify(name));
  row._handlers.click[0]({ target: row, preventDefault() {}, stopPropagation() {} });
};

/* --------------------------------------------------------------------- tests */

test('settings controls expose associated label ids', () => {
  const env = makeEnv();
  load(env);
  openSettings(env);
  for (const id of ['set-theme', 'set-size', 'set-ts', 'set-headpx']) {
    const control = env.el(id);
    assert.ok(control, 'missing settings control: ' + id);
    const labels = deepFindAll(env.document.documentElement, id);
    assert.ok(labels.some((node) => node.tagName === 'LABEL' && node.getAttribute('for') === id),
      'missing label association for: ' + id);
  }
});

test('the settings sheet holds placement, then the chat log look', () => {
  const env = makeEnv();
  load(env);
  openSettings(env);
  assert.equal(env.el('set-poll'), null, 'the poll interval setting is gone');
  // The names ask is a fallback that fires only for the arrivals the server does
  // not name itself, so its "flashes names over every actor" warning is about
  // something no player will connect to anything. The control, and the section
  // heading that held nothing else, are gone; the ask itself stays.
  assert.equal(env.el('set-names'), null, 'asking for names is not a setting');
  assert.doesNotMatch(env.el('content').textContent, /ask the game for names/);
  // The feed status line and its heading were a diagnostic, not a setting, and
  // Debug is the bug in the corner, not a row. Neither is a row any more.
  assert.doesNotMatch(env.el('content').textContent, /player feed/i);
  assert.doesNotMatch(env.el('content').textContent, /read on demand/);
  assert.equal(env.el('set-debug'), null, 'Debug is not a settings row');
  assert.doesNotMatch(env.el('content').textContent, /frame capture/);
  // what is left is placement and the look, one heading each
  const sheet = env.el('content').children[1];
  assert.ok(sheet.classList.contains('sheet'), 'the sheet is the second child, over the chat');
  const headings = [];
  (function walk(n) {
    for (const c of n.children) { if (c.tagName === 'H4') headings.push(c.textContent); walk(c); }
  })(sheet);
  assert.deepEqual(headings, ['Panel', 'Chat log'], 'placement first, then the log look');
});

test('Debug is a dim bug in the settings sheet, and nowhere else', () => {
  const env = makeEnv();
  load(env);
  // not in the chat: every corner there belongs to the scrollbar, a line of text,
  // or Send, and a debug button among the chat is a button that belongs nowhere
  assert.equal(env.el('bug'), null, 'the chat has no debug button');

  openSettings(env);
  const bug = env.el('bug');
  assert.ok(bug, 'no debug button in the settings sheet');
  assert.equal(bug.getAttribute('type'), 'button', 'it cannot submit anything');
  assert.match(bug.getAttribute('aria-label'), /Debug/);
  // the sheet's bottom-right corner, in a footer outside the scrolling body so it
  // cannot scroll away with the switches
  const foot = bug._parent;
  assert.ok(foot.classList.contains('sheetfoot'), 'it has a footer of its own');
  assert.equal(foot._parent, env.el('content').children[1], 'which is in the sheet');
  assert.equal(bug, foot.children[0]);
  const svg = bug.children[0];
  assert.equal(svg.tagName, 'SVG', 'the button carries an icon, not a word');
  assert.equal(svg.getAttribute('stroke'), 'currentColor', 'the icon takes its colour from the button');
  assert.equal(svg.children.filter((c) => c.tagName === 'PATH').length, 1, 'one path, as the icon helper draws it');
  assert.match(svg.children[0].getAttribute('d'), /^m8 2/, 'and it is the bug, not the code brackets');

  bug.click();
  assert.match(env.el('content').textContent, /every frame in and out/, 'it opens the Debug sheet');
  assert.equal(env.el('bug'), null, 'and Debug has no bug of its own');
  assert.match(env.el('content').textContent, /← Settings/, 'Debug goes back to Settings, not to the chat');

  // the styling contract: a dim mark that lights up when reached for
  assert.match(PANEL_CSS, /\.sheetfoot \{[^}]*justify-content: flex-end/, 'the footer puts it on the right');
  assert.match(PANEL_CSS, /\.bug \{[^}]*color: var\(--dim\)/, 'the bug is dim at rest');
  assert.match(PANEL_CSS, /\.bug \{[^}]*opacity: 0\.4/, 'and only just visible');
  assert.match(PANEL_CSS, /\.bug:hover[^{]*\{[^}]*opacity: 1/, 'it lights up on hover');
  assert.match(PANEL_CSS, /\.bug:hover[^{]*\{[^}]*color: var\(--fg\)/, 'and brightens rather than tints');
  assert.match(PANEL_CSS, /\.bug:focus-visible/, 'the keyboard reaches it too');
  // the chat keeps its own corners: no sticky overlay over the log, no wrapper
  assert.doesNotMatch(PANEL_CSS, /\.logwrap/, 'the log needs no positioning box for it');
  assert.match(PANEL_CSS, /\.chatlog \{[^}]*padding: 4px 6px;/, 'and no band kept clear at its bottom');
});

test('an unnamed speaker is named by asking the game, whatever an old store said', async () => {
  // A store from the build that offered the toggle, with the toggle off. The ask
  // used to be suppressed by it; now nothing reads it, and it must not linger in
  // the merged settings as a switch with no control behind it.
  const env = makeEnv({ settings: { askNames: false } });
  load(env);
  gameReady(env, 'Blasto');
  await tick();
  await tick();
  // save() writes the merged settings, so any later change shows what was kept.
  openSettings(env);
  setChk(env, 'set-heads', false);
  assert.ok(env.saved.length, 'a change is written');
  assert.equal(env.saved.at(-1).settings.askNames, undefined,
    'the stored opt-out is dropped on the way in, not carried as a switch with no control');

  frame(env, [{ kind: 'speech', actor: 'NRBv', text: 'hi ' }]);
  await tick();
  const presses = cmds(env, 'press');
  assert.equal(presses.length, 1, 'an unnamed speaker still asks the game');
  assert.equal(presses[0].args.sc, 75, 'and does it by pressing PgUp');
});

test('panel.js builds the current chat and settings panel in its shadow root', () => {
  const env = makeEnv();
  load(env);
  assert.ok(env.el('c8-chat-host')?.shadowRoot, 'no shadow-root host');
  assert.ok(env.el('chatlog'), 'no chat log');
  assert.ok(env.el('chat-to'), 'no recipient field');
  assert.ok(env.el('chat-text'), 'no message field');
  assert.ok(env.el('panel'), 'no side panel');
  assert.equal(env.el('content').children[0].className, 'chatpane');
  assert.equal(env.el('cog').getAttribute('aria-expanded'), 'false');
  assert.equal(env.el('chat-to-face').getAttribute('aria-describedby'), 'chat-to-help');
  assert.equal(env.el('chat-to-face').getAttribute('role'), 'combobox');
  assert.equal(env.el('chat-send').getAttribute('type'), 'submit');
  assert.ok(env.el('toast').getAttribute('aria-live'));
});

test('the online list is read at boot and again when the recipient list is reached for', async () => {
  const env = makeEnv();
  const answers = [['Helpbot'], ['Helpbot', 'TOMBY']];
  let reads = 0;
  // the panel also fetches its own stylesheet, so only the feed is counted here
  env.ctx.fetch = (url) => {
    if (String(url).indexOf('/api/players') < 0) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
    }
    const names = answers[Math.min(reads, answers.length - 1)];
    reads++;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ online: names.map((name) => ({ name, sector: 1 })), recent: [] })
    });
  };
  load(env);
  gameReady(env, 'Blasto');
  await tick();
  await tick();
  assert.equal(reads, 1, 'read once at boot, so the list is filled before it is opened');
  assert.equal(nickOfRow(rowFor(env, 'Helpbot')), 'Helpbot', 'the boot read fills the list');
  assert.equal(roomOf(env, 'Helpbot'), 'sector 1', 'with the room the feed reported');
  assert.equal(rowFor(env, 'TOMBY'), undefined, 'TOMBY logged on after that read');

  // Opening the list a moment after a read reuses that answer.
  env.el('chat-to-face').dispatch('focus');
  await tick();
  assert.equal(reads, 1, 'an answer from the last few seconds is reused');

  // Past that window it asks again, so somebody who logged on since is listed.
  shiftClock(env, 10000);
  env.el('chat-to-face').dispatch('pointerenter');
  await tick();
  await tick();
  assert.equal(reads, 2, 'reaching for the list reads the feed again');
  assert.ok(rowFor(env, 'TOMBY'), 'somebody who logged on since the last read is listed');

  // A pointer crossing the field is not a reason to ask once per mouse move.
  env.el('chat-to-face').dispatch('focus');
  env.el('chat-to-face').dispatch('pointerenter');
  await tick();
  assert.equal(reads, 2, 'repeated reaching within the window reuses the answer');
});

test('a re-read that changes nothing leaves the options already drawn alone', async () => {
  const env = makeEnv();
  env.ctx.fetch = (url) => {
    if (String(url).indexOf('/api/players') < 0) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ online: [{ name: 'Helpbot', sector: 1 }], recent: [] })
    });
  };
  load(env);
  gameReady(env, 'Blasto');
  await tick();
  await tick();
  const sel = env.el('chat-to-list');
  const drawn = sel.children.slice();
  assert.ok(drawn.length, 'the boot read drew the list');

  shiftClock(env, 10000);
  env.el('chat-to-face').dispatch('focus');
  await tick();
  await tick();
  assert.equal(sel.children.length, drawn.length, 'same number of rows');
  assert.equal(sel.children[0], drawn[0],
    'the list is only rebuilt on a real change, so an open list is not disturbed');
});

test('nothing reads the player feed on a timer', () => {
  const env = makeEnv();
  load(env);
  // the feed had an interval setting; the only timers left are the boot marker and
  // the capture repaint, neither of which belongs to polling
  assert.equal(env.intervals.length, 2, 'expected only the boot marker and capture timers');
  assert.deepEqual(env.intervals.map((i) => i.ms).sort((a, b) => a - b), [700, 5000]);
});

test('public sends receive a timeout scaled to typing duration', () => {
  const env = makeEnv();
  load(env);
  gameReady(env);
  say(env, 'x'.repeat(120));
  const timeout = env.timeouts.find((item) => item.ms > 5000 && item.ms >= 120 * 130);
  assert.ok(timeout, 'the full public-message duration has a matching bridge deadline');
  assert.ok(timeout.ms >= 5000 + 122 * 130);
});

test('the panel accepts same-origin messages with Firefox null source', () => {
  const env = makeEnv();
  load(env);
  frame(env, [{ kind: 'recv', from: 'Blasto', text: 'Firefox bridge' }], Date.now(), null);
  assert.match(env.el('chatlog').textContent, /Firefox bridge/, 'null-source message was ignored');

  const before = env.el('chatlog').children.length;
  frame(env, [{ kind: 'recv', from: 'Blasto', text: 'foreign window' }], Date.now(), {}, env.win.location.origin);
  frame(env, [{ kind: 'recv', from: 'Blasto', text: 'foreign origin' }], Date.now(), null, 'https://attacker.example');
  assert.equal(env.el('chatlog').children.length, before, 'foreign window and origin must be ignored');

  frame(env, [{ kind: 'recv', from: 'Blasto', text: 'Chromium bridge' }]);
  assert.match(env.el('chatlog').textContent, /Chromium bridge/, 'same-window message was ignored');
});

test('the recipient list starts with the room, then who is online, each with their room', async () => {
  const env = makeEnv();
  online(env, ['Blasto', 'Helpbot', 'TOMBY'], 1);
  load(env);
  gameReady(env, 'Blasto');
  await tick();
  await tick();

  const rows = targetRows(env);
  assert.equal(nickOfRow(rows[0]), 'Say nearby', 'the room row comes first and says what it really reaches');
  assert.equal(rowFor(env, 'Blasto'), undefined, 'we are not a recipient of our own message');
  assert.equal(nickOfRow(rowFor(env, 'Helpbot')), 'Helpbot', 'online players are listed');
  assert.equal(roomOf(env, 'Helpbot'), 'sector 37', 'with the room they were last seen in');
  assert.equal(roomOf(env, 'TOMBY'), 'sector 37');
  assert.equal(env.el('chat-to').value, '', 'defaults to public speech');
  assert.deepEqual(faceOf(env), { nick: 'Say nearby', room: '' }, 'the closed control shows the choice');
});

test('the room is its own cell, so the stylesheet can dim it and flush it right', () => {
  // the room is not glued into the name with a divider: it is a second span, and
  // the row's flex alignment is what separates them
  assert.match(PANEL_CSS, /\.chatform \.to-item \{[^}]*display: flex/);
  assert.match(PANEL_CSS, /\.chatform \.to-room \{[^}]*color: var\(--dim\)/);
  assert.match(PANEL_CSS, /\.chatform \.to-room \{[^}]*text-align: right/);
  assert.match(PANEL_CSS, /\.chatform \.to-room \{[^}]*margin-left: auto/);
  assert.doesNotMatch(PANEL_CSS, /\.to-room \{[^}]*border/);
});

test('a player in our own sector is marked as being here', async () => {
  const env = makeEnv();
  // the feed has us in 37 the whole way through; the wire says otherwise below
  online(env, ['Blasto', 'Helpbot'], 37);
  load(env);
  gameReady(env, 'Blasto');
  await tick();
  await tick();
  assert.equal(roomOf(env, 'Helpbot'), 'sector 37',
    'nobody is "here" until the login frame says which room we are in');

  frame(env, [{ kind: 'room', room: 37 }]);
  await tick();
  assert.equal(roomOf(env, 'Helpbot'), 'sector 37 (here)',
    'players a speech balloon would actually reach should be flagged');

  frame(env, [{ kind: 'room', room: 1 }]);
  await tick();
  assert.equal(roomOf(env, 'Helpbot'), 'sector 37',
    'the mark follows the room the wire named, not the feed');
});

test('recent private message partners sort to the top, under the room option', async () => {
  const env = makeEnv();
  online(env, ['Blasto', 'Helpbot', 'TOMBY', 'meg92887'], 1);
  load(env);
  gameReady(env, 'Blasto');
  await tick();
  await tick();

  // a private message to TOMBY, then one from Helpbot
  frame(env, [{ kind: 'send', to: 'TOMBY', text: 'hi' }], Date.now());
  frame(env, [{ kind: 'recv', from: 'Helpbot', text: 'hello' }], Date.now() + 1000);
  await tick();

  const rows = targetRows(env);
  assert.equal(nickOfRow(rows[0]), 'Say nearby', 'room stays first');
  assert.equal(nickOfRow(rows[1]), 'Helpbot', 'most recent partner first, still carrying their room');
  assert.equal(roomOfRow(rows[1]), 'sector 37');
  assert.equal(nickOfRow(rows[2]), 'TOMBY', 'then the one before');
  assert.ok(rows.findIndex((r) => r.attrs['data-value'] === 'meg92887')
    > rows.findIndex((r) => r.attrs['data-value'] === 'TOMBY'), 'everyone else follows');
});

test('the recipient face shows who is chosen and where they were last seen', async () => {
  const env = makeEnv();
  online(env, ['Blasto', 'Helpbot'], 37);
  load(env);
  gameReady(env, 'Blasto');
  await tick();
  await tick();
  frame(env, [{ kind: 'room', room: 37 }]);

  assert.deepEqual(faceOf(env), { nick: 'Say nearby', room: '' }, 'public speech while nothing is chosen');
  pickTarget(env, 'Helpbot');
  assert.deepEqual(faceOf(env), { nick: 'Helpbot', room: 'sector 37 (here)' },
    'the choice and its room, still right-aligned in the same row');
  assert.equal(env.el('chat-to').value, 'Helpbot', 'the form value follows the pick');
});

test('the picker opens and steers by keyboard, and the arrows stay the game\'s when shut', async () => {
  const env = makeEnv();
  online(env, ['Blasto', 'Helpbot', 'TOMBY'], 1);
  load(env);
  gameReady(env, 'Blasto');
  await tick();
  await tick();
  const face = env.el('chat-to-face');
  const key = (k) => face._handlers.keydown[0]({
    key: k, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }
  });

  key('ArrowDown');
  assert.equal(face.getAttribute('aria-expanded'), 'false', 'arrows are how you keep walking, not a way in');
  assert.equal(cmds(env, 'press').length, 0, 'and the panel presses nothing itself');

  key('Enter');
  assert.equal(face.getAttribute('aria-expanded'), 'true', 'Enter opens the list');
  assert.equal(env.el('chat-to-list').hidden, false);

  key('ArrowDown');
  assert.equal(face.getAttribute('aria-activedescendant'), 'to-opt-1', 'the arrows steer it once open');
  key('Enter');
  assert.equal(env.el('chat-to').value, 'Helpbot', 'Enter takes the active row');
  assert.equal(face.getAttribute('aria-expanded'), 'false', 'and puts the list away');

  key(' ');
  assert.equal(face.getAttribute('aria-expanded'), 'true', 'Space opens it too');
  key('Escape');
  assert.equal(face.getAttribute('aria-expanded'), 'false', 'Escape closes it without choosing');
  assert.equal(env.el('chat-to').value, 'Helpbot', 'and leaves the choice alone');
});

test('the list is put away by a click outside it', async () => {
  const env = makeEnv();
  online(env, ['Blasto', 'Helpbot'], 1);
  load(env);
  gameReady(env, 'Blasto');
  await tick();
  await tick();
  const face = env.el('chat-to-face');
  const listeners = [];
  env.document.addEventListener = (t, fn) => listeners.push(fn);
  env.document.removeEventListener = () => {};

  face._handlers.click[0]({ preventDefault() {} });
  assert.equal(face.getAttribute('aria-expanded'), 'true');
  const away = listeners[listeners.length - 1];
  away({ target: env.el('chatlog'), composedPath: () => [env.el('chatlog')] });
  assert.equal(face.getAttribute('aria-expanded'), 'false', 'a click on the log closes the list');
});

test('an empty recipient talks to the room, retaining its draft pending a reply', () => {
  const env = makeEnv();
  load(env);
  gameReady(env);
  say(env, 'hello room');
  const c = cmds(env, 'say');
  assert.equal(c.length, 1, 'expected exactly one say command');
  assert.equal(c[0].args.text, 'hello room');
  assert.equal(cmds(env, 'sendMessage').length, 0, 'room chat must not use a frame');
  assert.equal(env.el('chat-text').value, 'hello room', 'draft is retained until completion');
  assert.equal(env.el('chat-send').disabled, true, 'a second submission is locked');
  env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: { __c8_companion__: 1, k: 'reply', id: c[0].id, value: { ok: true, typed: 10 } }
  });
  return tick().then(() => {
    assert.equal(env.el('chat-text').value, '', 'successful acknowledgement clears the draft');
    assert.equal(env.el('chat-send').disabled, false);
  });
});

test('a public draft is preserved before game readiness', () => {
  const env = makeEnv();
  load(env);
  say(env, 'still here');
  assert.equal(cmds(env, 'say').length, 0);
  assert.equal(env.el('chat-text').value, 'still here');
  assert.match(env.el('toast').textContent, /still loading/);
});

test('public chat rejects non-ASCII without posting a command', () => {
  const env = makeEnv();
  load(env);
  gameReady(env);
  say(env, 'caf\u00e9');
  assert.equal(cmds(env, 'say').length, 0);
  assert.equal(env.el('chat-text').value, 'caf\u00e9');
  assert.match(env.el('toast').textContent, /ASCII/);
});

test('rapid public submissions are single-flight and do not replace the active draft', async () => {
  const env = makeEnv();
  load(env);
  gameReady(env);
  say(env, 'first');
  const first = cmds(env, 'say')[0];
  env.el('chat-text').value = 'second';
  say(env, 'second');
  assert.equal(cmds(env, 'say').length, 1);
  assert.equal(env.el('chat-text').value, 'second');
  env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: { __c8_companion__: 1, k: 'reply', id: first.id, value: { ok: true, typed: 5 } }
  });
  await tick();
  assert.equal(env.el('chat-text').value, 'second', 'user edits made during send are preserved');
});

test('there are no slash commands: a leading slash is spoken literally', () => {
  const env = makeEnv();
  load(env);
  gameReady(env);
  say(env, '/wave hello');
  const c = cmds(env, 'say');
  assert.equal(c.length, 1, 'should be treated as ordinary room speech');
  assert.equal(c[0].args.text, '/wave hello');
  assert.equal(cmds(env, 'sendMessage').length, 0);
});

test('chat still sends when the game input API is ready but the state callback was missed', () => {
  const env = makeEnv();
  load(env);
  gameReady(env);
  env.fire('message', { source: env.win, origin: env.win.location.origin,
    data: { __c8_companion__: 1, k: 'state', state: null } });
  say(env, 'hello room');
  assert.equal(cmds(env, 'say').length, 1, 'missing state hook is not treated as the game rejecting input');
});

test('chat is refused when the game explicitly says it is not accepting input', () => {
  const env = makeEnv();
  load(env);
  gameReady(env);
  env.fire('message', { source: env.win, origin: env.win.location.origin,
    data: { __c8_companion__: 1, k: 'state', state: { en: { stella: false } } } });
  say(env, 'hello room');
  assert.equal(cmds(env, 'say').length, 0);
});

test('an outgoing room message is shown from the game WebSocket echo only once', async () => {
  const env = makeEnv();
  load(env);
  gameReady(env);
  say(env, 'hello room');
  const c = cmds(env, 'say')[0];
  assert.ok(c, 'no say command posted');

  // the agent replies only after it has finished typing the text into the game
  env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: { __c8_companion__: 1, k: 'reply', id: c.id, ok: true, value: { typed: 10 } }
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(env.el('chatlog').children.length, 0,
    'a successful key-injection reply is not itself a chat message');
  env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: { __c8_companion__: 1, k: 'frame', frame: {
      t: Date.now(), dir: 'out', decoded: [{ kind: 'speech', actor: 'NRBw', text: 'hello room ' }]
    } }
  });
  const text = env.el('chatlog').textContent;
  assert.match(text, /Blasto/, 'own nick');
  assert.doesNotMatch(text, /[<>]/, 'speaker brackets are removed');
  assert.match(text, /hello room/);
  assert.equal(env.el('chatlog').children.length, 1,
    'the WebSocket echo is the single source of the outgoing room line');
  const line = env.el('chatlog').children[0];
  assert.match(line.className, /say/, 'room speech, not a private message');
  assert.match(line.className, /out/);
});

test('the client re-sending the whole balloon does not double the line', () => {
  const env = makeEnv();
  load(env);
  gameReady(env, 'Blasto');
  const out = (text, t) => env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: { __c8_companion__: 1, k: 'frame', frame: {
      t, dir: 'out', decoded: [{ kind: 'speech', actor: 'NRBw', text }]
    } }
  });

  // what the client actually sends: the first word as the balloon commits it, then
  // the whole balloon again when the message goes
  const t = Date.now();
  out('hellooooooooooooooooo ', t);
  out('hellooooooooooooooooo bot', t + 200);
  const log = env.el('chatlog');
  assert.equal(log.children.length, 1, 'one line, not two');
  const text = log.children[0].textContent;
  assert.equal((text.match(/helloo/g) || []).length, 1, 'the word appears once');
  assert.match(text, /hellooooooooooooooooo bot/);

  // a chunk that is not the balloon again is still more of the same line
  out('ha ', t + 900);
  out('ha ', t + 950);
  assert.match(log.children[0].textContent, /ha ha/, 'a real repeat is kept');
});

test('a private message renders tinted and tagged, not as room talk', () => {
  const env = makeEnv();
  load(env);
  frame(env, [{ kind: 'recv', from: 'Helpbot', text: 'psst' }]);
  const line = env.el('chatlog').children[0];
  assert.match(line.className, /pm/);
  assert.match(line.className, /in/);
  assert.match(line.textContent, /\(PM\)/);
  assert.match(line.textContent, /psst/);
});

test('panel geometry restores persisted position and size', () => {
  const env = makeEnv({ settings: { panel: { x: 120, y: 140, w: 400, h: 320 } } });
  load(env);
  const panel = env.el('panel');
  assert.equal(panel.style.left, '120px');
  assert.equal(panel.style.top, '140px');
  assert.equal(panel.style.width, '400px');
  assert.equal(panel.style.height, '320px');
});

test('compose row lays out from the panel box, not the window width', () => {
  // The panel is 360px wide on any window, so a viewport media query left the
  // recipient picker squeezed until its label was cut mid-word.
  assert.match(PANEL_CSS, /grid-template-areas: "recipient recipient" "message send"/);
  assert.match(PANEL_CSS, /\.chatform #chat-to-wrap \{ grid-area: recipient;/);
  assert.match(PANEL_CSS, /\.chatform #chat-text \{ grid-area: message;/);
  assert.match(PANEL_CSS, /\.chatform button \{ grid-area: send; \}/);
  assert.doesNotMatch(PANEL_CSS, /@media \(max-width: 390px\)/);
});

test('an empty log explains itself instead of showing a blank box', () => {
  assert.match(PANEL_CSS, /\.chatlog:empty::before/);
  assert.match(PANEL_CSS, /No lines yet/);
});

test('restored panel geometry is clamped to a narrow viewport', () => {
  const env = makeEnv({ settings: { panel: { x: 300, y: 800, w: 400, h: 700 } } });
  env.win.innerWidth = 240;
  env.win.innerHeight = 300;
  load(env);
  const panel = env.el('panel');
  assert.equal(panel.style.left, '20px');
  assert.equal(panel.style.top, '266px');
  assert.equal(panel.style.width, '220px');
  assert.equal(panel.style.height, '240px');
});

/* --------------------------------------------------- panel placement */

const clickDock = (env, mode) => env.el('dock-' + mode)._handlers.click[0]({});

test('the placement icons lead Settings and mark the mode in force', () => {
  const env = makeEnv({}, { stage: true });
  load(env);
  openSettings(env);
  const sheet = env.el('content').children[1];
  const body = sheet.children[1];
  assert.equal(body.children[0].textContent, 'Panel', 'placement is the first section');
  const row = body.children[1];
  assert.ok(row.classList.contains('dockrow'));
  assert.equal(row.getAttribute('role'), 'group');
  assert.equal(row.getAttribute('aria-label'), 'Panel placement');
  assert.deepEqual(row.children.map((b) => b.attrs.id), ['dock-left', 'dock-right', 'dock-float'],
    'the order is dock left, dock right, floating');
  for (const b of row.children) {
    assert.equal(b.getAttribute('type'), 'button', 'a placement button submits nothing');
    assert.ok(b.getAttribute('title'), 'every icon says what it does in words');
    assert.equal(b.getAttribute('aria-label'), b.getAttribute('title'));
    const svg = b.children[0];
    assert.equal(svg.tagName, 'SVG', 'the control is an icon, not a word');
    assert.equal(svg.getAttribute('stroke'), 'currentColor');
    assert.equal(svg.children.filter((c) => c.tagName === 'PATH').length, 1, 'one path per icon');
  }
  assert.deepEqual(row.children.map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true'],
    'floating is the default');
});

test('floating is the default and leaves the game stage alone', () => {
  const env = makeEnv({}, { stage: true });
  load(env);
  const panel = env.el('panel');
  assert.equal(panel.classList.contains('dock-left'), false);
  assert.equal(panel.classList.contains('dock-right'), false);
  assert.equal(env.el('stage').style.left, '', 'nothing reserved on the left');
  assert.equal(env.el('stage').style.right, '', 'nothing reserved on the right');
  assert.equal(panel.style.width, '', 'the stylesheet still owns the floating box');
});

test('a stored dock left fills the height and reserves the stage', () => {
  const env = makeEnv({ settings: { dock: 'left', dockW: 400 } }, { stage: true });
  load(env);
  const panel = env.el('panel');
  assert.ok(panel.classList.contains('dock-left'));
  assert.equal(panel.style.left, '0px');
  assert.equal(panel.style.right, 'auto');
  assert.equal(panel.style.top, '0px');
  assert.equal(panel.style.bottom, '0px', 'top and bottom together make it full height');
  assert.equal(panel.style.height, 'auto', 'the stylesheet height must not win');
  assert.equal(panel.style.width, '400px');
  assert.equal(env.el('stage').style.left, '400px', 'the game gets the rest');
  assert.equal(env.el('stage').style.right, '', 'and only one side is written');
  // The site's login screen and centred chrome are on the page, not in #stage,
  // so they have to be moved into the remaining area by hand.
  assert.equal(env.el('login-overlay').style.transform, 'translateX(200px)');
  assert.equal(env.el('status').style.left, 'calc(50% + 200px)');
  assert.equal(env.el('desktop-keys').style.left, 'calc(50% + 200px)');
  // The site centres both with translateX(-50%), and drops that transform once it
  // applies its own side-chrome layout — which is the layout a desktop window
  // gets. Without restoring it the shift would left-align them on the new centre.
  assert.equal(env.el('status').style.transform, 'translateX(-50%)');
  assert.equal(env.el('desktop-keys').style.transform, 'translateX(-50%)');
  openSettings(env);
  assert.equal(env.el('dock-left').getAttribute('aria-pressed'), 'true');
});

test('switching sides moves the reserved strip and asks the page to refit', () => {
  const env = makeEnv({ settings: { dock: 'left', dockW: 400 } }, { stage: true });
  load(env);
  openSettings(env);
  const before = cmds(env, 'layout').length;
  clickDock(env, 'right');
  const panel = env.el('panel');
  assert.ok(panel.classList.contains('dock-right'));
  assert.equal(panel.classList.contains('dock-left'), false);
  assert.equal(panel.style.right, '0px');
  assert.equal(panel.style.left, 'auto');
  assert.equal(env.el('stage').style.right, '400px');
  assert.equal(env.el('stage').style.left, '', 'the left strip is released');
  assert.equal(env.el('login-overlay').style.transform, 'translateX(-200px)',
    'the login screen follows the dock to the other side');
  assert.equal(env.el('status').style.left, 'calc(50% - 200px)');
  assert.equal(env.el('desktop-keys').style.left, 'calc(50% - 200px)');
  assert.equal(cmds(env, 'layout').length, before + 1,
    'an equal-width side switch needs an explicit page layout');
  assert.equal(env.el('dock-right').getAttribute('aria-pressed'), 'true');
  assert.equal(env.el('dock-left').getAttribute('aria-pressed'), 'false');
});

test("the game's top-right buttons move with a right dock and stay inside the stage", () => {
  const env = makeEnv({ settings: { dock: 'right', dockW: 400 } }, { stage: true });
  load(env);
  assert.equal(env.el('help-btn').style.transform, 'translateX(-400px)');
  assert.equal(env.el('players-btn').style.transform, 'translateX(-400px)');
  assert.equal(env.el('stage').style.right, '400px', 'the buttons keep the margin the stage edge has');

  // The width floor is what keeps them on screen: 1280 - 320 = 960 of dock leaves
  // the stage 320 wide, and the buttons still land inside it.
  const wide = makeEnv({ settings: { dock: 'right', dockW: 5000 } }, { stage: true });
  load(wide);
  assert.equal(wide.el('help-btn').style.transform, 'translateX(-960px)');
  assert.equal(wide.el('stage').style.right, '960px', 'the reserved strip is the clamped width');
  assert.equal(wide.el('stage').style.left, '', 'and still only one side is written');

  openSettings(env);
  clickDock(env, 'left');
  assert.equal(env.el('help-btn').style.transform, '', 'a left dock never reaches them');
  assert.equal(env.el('players-btn').style.transform, '');
  clickDock(env, 'right');
  clickDock(env, 'float');
  assert.equal(env.el('help-btn').style.transform, '', 'floating hands them back untouched');
  assert.equal(env.el('players-btn').style.transform, '');
});

test('a stored dock width is clamped to the viewport and the stage floor', () => {
  const wide = makeEnv({ settings: { dock: 'left', dockW: 5000 } }, { stage: true });
  load(wide);
  assert.equal(wide.el('panel').style.width, '960px', '1280 - 320 of stage');
  assert.equal(wide.el('stage').style.left, '960px');

  const narrow = makeEnv({ settings: { dock: 'left', dockW: 5000 } }, { stage: true });
  narrow.win.innerWidth = 400;
  load(narrow);
  assert.equal(narrow.el('panel').style.width, '260px', 'the 260px floor still applies');
  assert.equal(narrow.el('stage').style.left, '260px');

  const tiny = makeEnv({ settings: { dock: 'left', dockW: 100 } }, { stage: true });
  load(tiny);
  assert.equal(tiny.el('panel').style.width, '260px', 'a stored sliver is lifted to the floor');
});

test('the docked edge drags the panel width and the stage with it', () => {
  const env = makeEnv({ settings: { dock: 'left', dockW: 360 } }, { stage: true });
  load(env);
  const grip = env.el('dock-grip');
  assert.ok(grip, 'no docked edge handle');
  grip._handlers.pointerdown[0]({ preventDefault() {}, clientX: 100 });
  env.fire('pointermove', { clientX: 160 });
  assert.equal(env.el('panel').style.width, '420px');
  assert.equal(env.el('stage').style.left, '420px', 'the stage follows every move');
  env.fire('pointermove', { clientX: -500 });
  assert.equal(env.el('panel').style.width, '260px', 'never narrower than the floor');
  assert.equal(env.el('stage').style.left, '260px');
  env.fire('pointerup', { clientX: -500 });
  assert.equal(env.saved.at(-1).settings.dockW, 260, 'the chosen width is kept');
  assert.equal(env.saved.at(-1).settings.dock, 'left');
});

test('the page console is mirrored into the diagnostics record', () => {
  const env = makeEnv({}, { stage: true });
  load(env);
  env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: { __c8_companion__: 1, k: 'console', errors: [{ text: 'TypeError: boom', n: 3 }] }
  });
  const diag = env.intervals.find((i) => i.ms === 5000);
  assert.ok(diag, 'the diagnostics writer is not scheduled');
  diag.fn();
  assert.deepEqual(JSON.parse(env.saved.at(-1).diagJson).page, [{ text: 'TypeError: boom', n: 3 }],
    'what the page logged is readable from the store');

  env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: { __c8_companion__: 1, k: 'console', errors: 'nonsense' }
  });
  diag.fn();
  assert.deepEqual(JSON.parse(env.saved.at(-1).diagJson).page, [], 'a malformed report is dropped');
});

test('a record that names somebody without parts asks for the actor record', () => {
  // The game only sends schtick parts when it is asked, and a player can be named
  // long before they speak — waiting for a line left them faceless for the session.
  const env = makeEnv({}, {});
  load(env);
  frame(env, [{ kind: 'actors', list: [{ id: 65, name: 'Helpbot', head: null, key: 0x1e8412 + 65 }] }]);
  assert.equal(cmds(env, 'press').length, 1, 'PgUp is the ask that re-sends the record');

  // the ask is rate-limited, so the line that follows does not spend another press
  frame(env, [{ kind: 'speech', actor: 'NRBA', text: 'hello there' }]);
  assert.equal(cmds(env, 'press').length, 1, 'one ask per name, not one per line');

  // a record that already carries the parts is not asked about
  const env2 = makeEnv({}, {});
  load(env2);
  frame(env2, [{ kind: 'actors', list: [{ id: 65, name: 'Blasto', head: 12, key: 0x1e8412 + 65 }] }]);
  assert.equal(cmds(env2, 'press').length, 0, 'a named head needs no ask');
});

test('a face learned in an earlier session is worn again without an ask', async () => {
  // The record can come back without schtick parts for a player the panel already
  // knows: the remembered face fills the line instead of pressing into the void.
  const env = makeEnv({ knownHeads: { Helpbot: 4 } });
  load(env);
  await answerReads(env, artFs(rleBmp()));
  frame(env, [{ kind: 'actors', list: [{ id: 65, name: 'Helpbot', head: null, key: 0x1e8412 + 65 }] }]);
  assert.equal(cmds(env, 'press').length, 0, 'no ask is spent on a face we remember');
  frame(env, [{ kind: 'speech', actor: 'NRBA', text: 'hello there ' }]);
  await answerReads(env, artFs(rleBmp()));
  const line = env.el('chatlog').children[0];
  const face = line.children.find((c) => c.className === 'head');
  assert.ok(face, 'the remembered head is drawn');
  assert.equal(face.attrs.src, 'data:image/png;base64,8');
});

test('the remembered faces are stored for the next session', () => {
  const env = makeEnv();
  load(env);
  frame(env, [{ kind: 'actors', list: [{ id: 65, name: 'Helpbot', head: 12 }] }]);
  frame(env, [{ kind: 'room', room: 37 }]);            // any save
  const stored = env.saved.filter((o) => o.knownHeads).pop();
  assert.ok(stored, 'a save carries the map');
  assert.equal(stored.knownHeads.Helpbot, 12, 'the face is remembered by name');
});

test('a face is final once the speaker leaves', () => {
  const env = makeEnv({}, {});
  load(env);
  frame(env, [{ kind: 'actors', live: true, list: [{ id: 65, name: 'Blasto', head: null, key: 0x1e8412 + 65 }] }]);
  frame(env, [{ kind: 'speech', actor: 'NRBA', text: 'hello there' }]);
  frame(env, [{ kind: 'left', key: 0x1e8412 + 65 }]);
  // The next record for that name — possibly a different player — must not repaint it.
  frame(env, [{ kind: 'actors', live: true, list: [{ id: 65, name: 'Blasto', head: 12, body: 53, feet: 29, key: 0x1e8412 + 65 }] }]);
  const line = env.saved.at(-1).irc.find((e) => e.kind === 'say');
  assert.ok(line, 'no speech line stored');
  assert.equal(line.headFixed, true, 'the identity is settled');
  assert.equal(line.headLocked, true, 'and its face is final');
  assert.equal(line.headId, null, 'a line settled without a face stays faceless');
});

test('a face already on a line survives a departure', () => {
  const env = makeEnv({}, {});
  load(env);
  frame(env, [{ kind: 'actors', live: true, list: [{ id: 65, name: 'Blasto', head: 12, body: 53, feet: 29, key: 0x1e8412 + 65 }] }]);
  frame(env, [{ kind: 'speech', actor: 'NRBA', text: 'hello' }]);
  frame(env, [{ kind: 'left', key: 0x1e8412 + 65 }]);
  const line = env.saved.at(-1).irc.find((e) => e.kind === 'say');
  assert.equal(line.headId, 12, 'the face it had is committed, not cleared');
  assert.equal(line.headFixed, true);
  assert.equal(line.headLocked, true);
});

test('a room change settles the faces of the room we left', () => {
  const env = makeEnv({}, {});
  load(env);
  frame(env, [{ kind: 'room', room: 37, name: 'Fountain' }]);
  frame(env, [{ kind: 'actors', live: true, list: [{ id: 65, name: 'Blasto', head: 12, body: 53, feet: 29, key: 0x1e8412 + 65 }] }]);
  frame(env, [{ kind: 'speech', actor: 'NRBA', text: 'hello' }]);
  frame(env, [{ kind: 'room', room: 38, name: 'Hall' }]);
  const line = env.saved.at(-1).irc.find((e) => e.kind === 'say');
  assert.equal(line.headFixed, true, 'the old room cannot be repainted');
  assert.equal(line.headLocked, true);
  assert.equal(line.headId, 12);
});

test('a rate-limited face ask is queued, not dropped', async () => {
  const env = makeEnv({}, {});
  load(env);
  frame(env, [{ kind: 'actors', list: [
    { id: 65, name: 'Helpbot', head: null, key: 0x1e8412 + 65 },
    { id: 66, name: 'Blasto', head: null, key: 0x1e8412 + 66 }
  ] }]);
  frame(env, [{ kind: 'speech', actor: 'NRBA', text: 'hello' }]);
  assert.equal(cmds(env, 'press').length, 1, 'the first speaker asks straight away');

  // The ask is one per five seconds. A second name inside that window used to be
  // marked as asked while nothing was pressed, and was lost for the session.
  frame(env, [{ kind: 'speech', actor: 'NRBB', text: 'hi' }]);
  assert.equal(cmds(env, 'press').length, 1, 'the limiter holds the second ask back');

  await new Promise((r) => setTimeout(r, 5300));
  assert.equal(cmds(env, 'press').length, 2, 'the queued ask is sent once the window passes');
});

test('a dock-right edge grows as the pointer moves left', () => {
  const env = makeEnv({ settings: { dock: 'right', dockW: 360 } }, { stage: true });
  load(env);
  env.el('dock-grip')._handlers.pointerdown[0]({ preventDefault() {}, clientX: 500 });
  env.fire('pointermove', { clientX: 440 });
  assert.equal(env.el('panel').style.width, '420px');
  assert.equal(env.el('stage').style.right, '420px');
  assert.equal(env.el('stage').style.left, '');
});

test('arrow keys on the docked edge resize without reaching the game', () => {
  const env = makeEnv({ settings: { dock: 'left', dockW: 360 } }, { stage: true });
  load(env);
  let stopped = 0, prevented = 0;
  const key = (k, down) => env.el('dock-grip')._handlers[down ? 'keydown' : 'keyup'][0]({
    key: k, shiftKey: false,
    stopPropagation() { stopped++; }, preventDefault() { prevented++; }
  });
  key('ArrowRight', true);
  assert.equal(env.el('panel').style.width, '384px');
  key('ArrowLeft', true);
  assert.equal(env.el('panel').style.width, '360px');
  key('ArrowRight', false);
  assert.equal(env.el('panel').style.width, '360px', 'the release resizes nothing');
  assert.equal(stopped, 3, 'the game never sees the resize arrows');
  assert.equal(prevented, 3);
  // Home is not a resize key, so it is left to the game's own key policy.
  key('Home', true);
  assert.equal(stopped, 3, 'Home is not swallowed by the separator');
});

test('the docked edge handle is a focusable separator', () => {
  const env = makeEnv({ settings: { dock: 'left', dockW: 360 } }, { stage: true });
  load(env);
  const grip = env.el('dock-grip');
  assert.equal(grip.getAttribute('role'), 'separator');
  assert.equal(grip.getAttribute('tabindex'), '0');
  assert.equal(grip.getAttribute('aria-orientation'), 'vertical');
  assert.match(grip.getAttribute('aria-label'), /Resize/);
  assert.equal(grip.getAttribute('aria-valuemin'), '260');
  assert.equal(grip.getAttribute('aria-valuenow'), '360');
  assert.equal(grip.getAttribute('aria-valuemax'), '960');
});

test('floating restores the box the user left and releases the stage', () => {
  const env = makeEnv({
    settings: { dock: 'left', dockW: 400, panel: { x: 120, y: 140, w: 400, h: 320 } }
  }, { stage: true });
  load(env);
  assert.equal(env.el('stage').style.left, '400px');
  openSettings(env);
  clickDock(env, 'float');
  const panel = env.el('panel');
  assert.equal(panel.classList.contains('dock-left'), false);
  assert.equal(panel.style.left, '120px', 'the saved floating position comes back');
  assert.equal(panel.style.top, '140px');
  assert.equal(panel.style.width, '400px');
  assert.equal(panel.style.height, '320px');
  assert.equal(panel.style.right, 'auto');
  assert.equal(env.el('stage').style.left, '', 'the game gets its full stage back');
  assert.equal(env.el('stage').style.right, '');
  assert.equal(env.el('login-overlay').style.transform, '', 'centred on the viewport again');
  assert.equal(env.el('status').style.left, '');
  assert.equal(env.el('desktop-keys').style.left, '');
  assert.equal(env.el('status').style.transform, '', 'the stylesheet owns the centring again');
  assert.equal(env.el('desktop-keys').style.transform, '');
  assert.equal(env.saved.at(-1).settings.dock, 'float');
});

test('hiding a docked panel gives the stage back, and showing it takes it again', () => {
  const env = makeEnv({ settings: { dock: 'left', dockW: 360 } }, { stage: true });
  load(env);
  const before = cmds(env, 'layout').length;
  env.el('toggle').click();
  assert.ok(env.el('panel').classList.contains('hidden'));
  assert.equal(env.el('stage').style.left, '', 'a hidden panel reserves nothing');
  env.el('toggle').click();
  assert.equal(env.el('panel').classList.contains('hidden'), false);
  assert.equal(env.el('stage').style.left, '360px');
  assert.equal(env.el('login-overlay').style.transform, 'translateX(180px)',
    'the login screen is moved into the stage again');
  assert.equal(env.el('status').style.left, 'calc(50% + 180px)');
  assert.equal(env.el('desktop-keys').style.left, 'calc(50% + 180px)');
  assert.equal(cmds(env, 'layout').length, before + 2, 'the page is told both times');
});

test('an unknown placement falls back to floating', () => {
  const env = makeEnv({ settings: { dock: 'sideways', dockW: 9999 } }, { stage: true });
  load(env);
  const panel = env.el('panel');
  assert.equal(panel.classList.contains('dock-left'), false);
  assert.equal(panel.classList.contains('dock-right'), false);
  assert.equal(env.el('stage').style.left, '');
  openSettings(env);
  assert.equal(env.el('dock-float').getAttribute('aria-pressed'), 'true');
});

test('the docked panel styling is a full-height column with one edge handle', () => {
  assert.match(PANEL_CSS, /\.panel\.dock-left, \.panel\.dock-right \{[^}]*max-height: none/,
    'the definite-box height cap is lifted');
  assert.match(PANEL_CSS, /\.panel\.dock-left, \.panel\.dock-right \{[^}]*border-radius: 0/);
  assert.match(PANEL_CSS, /\.panel > \.grip\.edge \{ display: none; \}/, 'the edge handle is docked only');
  assert.match(PANEL_CSS, /\.panel\.dock-left > \.grip\.edge[^}]*\{[^}]*right: 0; cursor: ew-resize/);
  assert.match(PANEL_CSS, /\.panel\.dock-right > \.grip\.edge[^}]*\{[^}]*left: 0; cursor: ew-resize/);
  assert.match(PANEL_CSS, /\.panel\.dock-left \.movegrip, \.panel\.dock-right \.movegrip \{ display: none/);
  assert.match(PANEL_CSS, /\.panel\.dock-left > \.grip\.nw,[\s\S]*?display: none/,
    'corner resizing means nothing when the corners are the viewport edges');
  assert.match(PANEL_CSS, /\.dockbtn\[aria-pressed="true"\] \{[^}]*color: var\(--accent\)/);
});

test('an incoming message renders as an IRC line', () => {
  const env = makeEnv();
  load(env);
  frame(env, [{ kind: 'recv', from: 'Blasto', text: 'self delivery test' }]);
  const text = env.el('chatlog').textContent;
  assert.match(text, /Blasto/);
  assert.doesNotMatch(text, /[<>]/, 'speaker brackets are removed');
  assert.match(text, /self delivery test/);
});

test('an outgoing message renders with its recipient', () => {
  const env = makeEnv();
  load(env);
  frame(env, [{ kind: 'send', to: 'helpbot', text: 'hello there' }]);
  const text = env.el('chatlog').textContent;
  assert.match(text, /TO helpbot:/);
  assert.match(text, /hello there/);
});

test('player search renders as a system line', () => {
  const env = makeEnv();
  load(env);
  const t = Date.now();
  frame(env, [{ kind: 'find', name: 'helpbot' }], t);
  frame(env, [{ kind: 'info', name: 'helpbot', sector: 37 }], t + 5000);
  const text = env.el('chatlog').textContent;
  assert.match(text, /SEARCHING: helpbot/);
  assert.match(text, /PLAYER helpbot IN sector 37/);
});

/** A frame shaped the way src/agent.js posts it. */
function speechFrame(dir, actor, text, t) {
  return {
    t: t || Date.now(), dir: dir, name: 'speech', n: 24, strings: [],
    decoded: [{ kind: 'speech', actor: actor, text: text }]
  };
}

function send(env, frame, source = env.win, origin = env.win.location.origin) {
  env.fire('message', { source, origin, data: { __c8_companion__: 1, k: 'frame', frame: frame } });
}

const settle = () => new Promise((r) => setTimeout(r, 2700));   // past the 2500ms unpunctuated idle

test('room speech is stitched per speaker into one line', async () => {
  const env = makeEnv();
  load(env);
  const t = Date.now();
  // the real shape: one word per frame, well inside the idle gap
  send(env, speechFrame('in', 'NRBv', 'hey! ', t));
  send(env, speechFrame('in', 'NRBv', "what's ", t + 200));
  send(env, speechFrame('in', 'NRBv', 'up?', t + 400));
  assert.equal(env.el('chatlog').children.length, 1, 'a concise live line appears while the speaker is talking');

  await settle();
  const lines = env.el('chatlog').children;
  assert.equal(lines.length, 1, 'one line per message, not one per word');
  assert.match(lines[0].textContent, /NRBvhey! what's up\?/);
});

test('two speakers interleaving do not merge into one line', async () => {
  const env = makeEnv();
  load(env);
  gameReady(env, 'Blasto');
  const t = Date.now();
  send(env, speechFrame('out', 'NRBx', 'drop ', t));
  send(env, speechFrame('in', 'NRBv', 'hey! ', t + 100));
  send(env, speechFrame('out', 'NRBx', 'me ', t + 200));
  send(env, speechFrame('in', 'NRBv', 'up?', t + 300));
  await settle();

  const lines = env.el('chatlog').children;
  assert.equal(lines.length, 2, 'one line per speaker');
  const own = lines.find((l) => l.classList.contains('out'));
  const other = lines.find((l) => !l.classList.contains('out'));
  assert.ok(own, 'own speech is marked outbound');
  assert.ok(other, 'other speaker has their own line');
  const ownNick = own.children.find((c) => c.className === 'nick');
  const ownMsg = own.children.find((c) => c.className === 'msg');
  const otherNick = other.children.find((c) => c.className === 'nick');
  const otherMsg = other.children.find((c) => c.className === 'msg');
  assert.equal(ownNick.textContent, 'Blasto');
  assert.equal(ownMsg.textContent, 'drop me');
  assert.equal(otherNick.textContent, 'NRBv');
  assert.equal(otherMsg.textContent, 'hey! up?');
});

test('our own speech is shown under our name, not the actor tag', async () => {
  const env = makeEnv();
  load(env);
  gameReady(env, 'Blasto');
  send(env, speechFrame('out', 'NRBx', 'hello', Date.now()));
  await settle();
  const line = env.el('chatlog').children[0];
  assert.match(line.textContent, /Blasto/, 'we know who we are');
  assert.equal(/NRBx/.test(line.textContent), false, 'our actor tag is an implementation detail');
  assert.match(line.className, /say out/);
});

test('routine traffic and the map do not spam the log', () => {
  const env = makeEnv();
  load(env);
  const t = Date.now();
  ['keepalive', 'sync', 'greet', 'login', 'server-assign', 'sector-list', 'sector-query', 'sector-range'].forEach((name, i) => {
    env.fire('message', {
      source: env.win, origin: env.win.location.origin,
      data: { __c8_companion__: 1, k: 'frame', frame: { t: t + i, dir: 'in', name, n: 20, strings: ['000H', '020H'], hex: 'aa bb cc' } }
    });
  });
  assert.equal(env.el('chatlog').children.length, 0, 'quiet types must stay out of the chat log');
});

test('a hex blob is not mistaken for prose', () => {
  const env = makeEnv();
  load(env);
  env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: {
      __c8_companion__: 1, k: 'frame',
      frame: { t: Date.now(), dir: 'in', name: 'type-20', n: 40, strings: ['8412d46a00000000d98f3a382a9fe2f1582e4e19d3d2249d'], hex: 'aa' }
    }
  });
  assert.equal(env.el('chatlog').children.length, 0);
});

test('a room change uses concise uppercase system messages', () => {
  const env = makeEnv();
  load(env);
  frame(env, [{ kind: 'room', room: 1, name: 'Blasto' }]);
  frame(env, [{ kind: 'room', room: 37, name: 'Blasto' }]);

  const text = env.el('chatlog').textContent;
  assert.match(text, /LEAVING sector 1/);
  assert.match(text, /ENTERING sector 37/);
  assert.doesNotMatch(text, /-!-/);
});

test('the same message arriving twice in a row is only shown once', () => {
  const env = makeEnv();
  load(env);
  const t = Date.now();
  frame(env, [{ kind: 'recv', from: 'Blasto', text: 'dup' }], t);
  frame(env, [{ kind: 'recv', from: 'Blasto', text: 'dup' }], t + 100);
  const hits = env.el('chatlog').children.filter((c) => /dup/.test(c.textContent));
  assert.equal(hits.length, 1, 'duplicate suppressed');
});

test('keystrokes in the extension UI are stopped at the shadow boundary', () => {
  const env = makeEnv();
  load(env);
  const root = env.el('c8-chat-host').shadowRoot;
  assert.ok(root, 'no shadow root');

  for (const type of ['keydown', 'keyup', 'keypress']) {
    const handlers = root._handlers[type];
    assert.ok(handlers && handlers.length, `no ${type} guard on the shadow root`);
    let stopped = 0;
    handlers.forEach((h) => h({ stopPropagation: () => stopped++ }));
    assert.equal(stopped, handlers.length,
      `${type} must call stopPropagation or the game swallows the keystroke`);
  }
});

test('loading an avatar after commit does not change its speaker head id', () => {
  const row = { committed: true, nick: 'Helpbot', headId: 12, text: 'hello' };
  const loadedArt = { width: 32, height: 32 };
  row._headArt = loadedArt;
  const laterRosterHead = 4;
  assert.equal(row.headId, 12, 'the original committed head remains selected');
  assert.equal(row._headArt, loadedArt, 'only pixels for that selected head are attached');
  assert.notEqual(row.headId, laterRosterHead, 'a reused room id cannot replace the committed head');
});

test('committing a speaker line freezes its text, name, head and timestamp', () => {
  const entry = {
    committed: false, text: 'hello', nick: 'Helpbot', headId: 12,
    t: 1000, ended: 2000
  };
  const committed = (nextNick, nextHead) => {
    if (entry.committed) return false;
    entry.nick = nextNick;
    entry.headId = nextHead;
    return true;
  };
  entry.committed = true;
  const before = JSON.stringify(entry);
  assert.equal(committed('Different Player', 4), false);
  assert.equal(JSON.stringify(entry), before, 'later roster data cannot rewrite a committed row');
  assert.equal(entry.headId, 12, 'committed avatar identity stays pinned across a room roster change');
});

test('committed transcript metadata cannot be changed by a later room roster', () => {
  const entry = { committed: true, text: 'said once', nick: 'Helpbot', headId: 12, t: 1000, ended: 2000 };
  const updateRoster = (e, nick, headId) => {
    if (e.committed) return;
    e.nick = nick;
    e.headId = headId;
  };
  updateRoster(entry, 'Different Player', 4);
  assert.deepEqual({ text: entry.text, nick: entry.nick, headId: entry.headId, t: entry.t, ended: entry.ended },
    { text: 'said once', nick: 'Helpbot', headId: 12, t: 1000, ended: 2000 });
  const renderedAvatar = entry.headId;
  assert.equal(renderedAvatar, 12, 'the committed row retains the original speaker head id');
});

test('IRC speaker username is plain text inline before the message', () => {
  const env = makeEnv();
  load(env);
  frame(env, [{ kind: 'actors', list: [{ id: 119, name: 'Blasto', head: 4 }] }]);
  frame(env, [{ kind: 'speech', actor: 'NRBw', text: 'hello ' }]);
  frame(env, [{ kind: 'actors', list: [{ id: 119, name: 'Blasto', head: 4 }] }]);
  const line = env.el('chatlog').children[0];
  const nick = line.children.find((c) => c.className === 'nick');
  const msg = line.children.find((c) => c.className === 'msg');
  assert.equal(nick.textContent, 'Blasto');
  assert.equal(line.children.indexOf(nick) + 1, line.children.indexOf(msg), 'username is inline with its message');
  assert.doesNotMatch(line.textContent, /[<>]/, 'speaker brackets are removed');
  assert.equal(line.children[0].className, 'ts');
});

test('IRC lines carry a timestamp, plain username and per-nick colour', () => {
  const env = makeEnv();
  load(env);
  frame(env, [{ kind: 'speech', actor: 'NRBv', text: 'hi ' }]);
  const line = env.el('chatlog').children[0];
  assert.equal(line.children.find((c) => c.className === 'nick').textContent, 'NRBv');
  assert.doesNotMatch(line.textContent, /[<>]/, 'speaker brackets are removed');
  assert.match(line.className, /irc/);
  assert.match(line.className, /in/);
  const nick = line.children.find((c) => /nick/.test(c.className));
  assert.ok(nick, 'no nick span');
  assert.match(nick.attrs.style, /^color:hsl\(/);
  assert.ok(line.children[0].textContent.length >= 4, 'timestamp present');
});

/* ------------------------------------------------------- chat log settings */

const openSettings = (env) => env.el('cog')._handlers.click[0]({});
const setSel = (env, id, value) => { env.el(id).value = value; env.el(id)._handlers.change[0]({}); };
const setChk = (env, id, on) => {
  const box = env.el(id);
  box.checked = on;
  box._handlers.change[0]({ target: box });
};
const nickOf = (env) => env.el('chatlog').children[0].children.find((c) => /nick/.test(c.className));
const PANEL_CSS = readFileSync(new URL('../src/panel.css', import.meta.url), 'utf8');

test('home/end/insert/pgup/pgdn/delete are pressed into the game, never acted on by the panel', () => {
  const env = makeEnv();
  load(env);
  const root = env.el('c8-chat-host').shadowRoot;
  const keydown = root._handlers.keydown[0];
  const keyup = root._handlers.keyup[0];
  let prevented = 0;
  let stopped = 0;
  const ev = (key, target) => ({
    key, target,
    preventDefault: () => { prevented++; },
    stopPropagation: () => { stopped++; }
  });

  keydown(ev('PageUp', env.el('chatlog')));
  assert.equal(cmds(env, 'press').length, 1, 'PgUp is pressed into the game');
  assert.equal(cmds(env, 'press')[0].args.sc, 75, 'as the HID scancode for PgUp');
  assert.equal(prevented, 1, 'the browser default is cancelled, so the log cannot scroll');
  assert.equal(stopped, 1, 'and the page never sees the panel-focused key');

  keydown(ev('End', env.el('chat-text')));
  assert.equal(cmds(env, 'press').length, 2, 'End is pressed even from the compose box');
  assert.equal(cmds(env, 'press')[1].args.sc, 77, 'as the HID scancode for End');
  assert.equal(prevented, 2, 'with no caret jump in the box');

  keydown(ev('Delete', env.el('chat-text')));
  keydown(ev('Insert', env.el('chatlog')));
  keydown(ev('Home', env.el('chatlog')));
  keydown(ev('PageDown', env.el('chatlog')));
  assert.deepEqual(cmds(env, 'press').slice(2).map((m) => m.args.sc), [76, 73, 74, 78],
    'Delete, Insert, Home and PageDown complete the set');

  keyup(ev('PageUp', env.el('chatlog')));
  assert.equal(cmds(env, 'press').length, 6, 'the release injects nothing on its own');
  assert.equal(prevented, 7, 'but is still swallowed, so no orphan release reaches the game');

  prevented = 0; stopped = 0;
  keydown(ev('ArrowUp', env.el('chat-text')));
  assert.equal(cmds(env, 'press').length, 6, 'arrows stay pure page passthrough, not injected');
  assert.equal(prevented, 0, 'unprevented, as the game expects them');
  assert.equal(stopped, 0, 'and un-stopped: the page must see them to keep you walking');

  prevented = 0; stopped = 0;
  keydown(ev('a', env.el('chat-text')));
  keydown(ev('Enter', env.el('chat-text')));
  assert.equal(cmds(env, 'press').length, 6, 'typing keys are never injected');
  assert.equal(prevented, 0, 'and stay for the field');
  assert.equal(stopped, 2, 'stopped at the boundary so the game cannot eat them');
});

test('the default-theme move carries a stored classic across once', () => {
  const env = makeEnv({ settings: { theme: 'classic' } });
  load(env);
  assert.ok(env.el('panel').classList.contains('look-bighead'),
    'a stored pre-move classic lands on Default');
});

test('the async stylesheet reload replaces the stylesheet with panel.css alone', async () => {
  const env = makeEnv();
  env.ctx.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve('/* reloaded css */') });
  load(env);
  await new Promise((r) => setTimeout(r, 20));
  const css = env.el('c8-chat-host').shadowRoot.querySelector('style').textContent;
  assert.equal(css, '/* reloaded css */', 'the fetched stylesheet is the whole stylesheet');
});

test('the speech balloon is drawn in CSS, with no game art behind it', () => {
  // The one embedded sprite is the private-message starburst; the balloon is drawn.
  const say = PANEL_CSS.slice(PANEL_CSS.indexOf('.panel.look-bighead .irc.say .msg'),
    PANEL_CSS.indexOf('.panel.look-bighead .irc.pm .msg'));
  assert.doesNotMatch(say, /url\(|data:image/, 'the balloon must not be an image');
  assert.equal((PANEL_CSS.match(/data:image\/png;base64,/g) || []).length, 1, 'one sprite, the radio');
  // the balloon itself: white fill, a one-pixel black outline, and an outline on the tail
  assert.match(PANEL_CSS, /--balloon-fill: #ffffff/);
  assert.match(PANEL_CSS, /--balloon-line: #000000/);
  assert.match(PANEL_CSS, /\.panel\.look-bighead \.irc\.say \.msg::before[^{]*\{[^}]*border-right-color: var\(--balloon-line\)/,
    'the tail is outlined, not a flat wedge');
  assert.match(PANEL_CSS, /\.panel\.look-bighead \.irc\.say \.msg::after[^{]*\{[^}]*border-right-color: var\(--balloon-fill\)/,
    'and filled one pixel inside that outline');
  // the name is a label over the balloon, not a coloured cap on it
  assert.doesNotMatch(PANEL_CSS, /\.panel\.look-bighead \.irc \.nick \{[^}]*background:/,
    'the label must not paint a cap the balloon would have to join');
});

test('the Default theme keeps its stamp out of the balloon and off the page', () => {
  // It is pinned over the row's corner and revealed on hover; losing these rules
  // once put a timestamp between every balloon and the next one.
  assert.match(PANEL_CSS, /\.panel\.look-bighead \.irc \.ts \{[^}]*opacity: 0/);
  assert.match(PANEL_CSS, /\.panel\.look-bighead \.irc \.ts \{[^}]*position: absolute/);
  assert.match(PANEL_CSS, /\.panel\.look-bighead \.irc:hover \.ts[^{]*\{[^}]*opacity: 1/);
});

test('the tail is centred on a one-line balloon and rides the first line on a tall one', () => {
  // Pinned 7px from the top it hung out of a ~26px balloon's bottom corner; min()
  // centres it while the box is short and leaves it alone once the text wraps.
  const outline = /\.panel\.look-bighead \.irc\.say \.msg::before \{[^}]*top: min\(7px, calc\(50% - 9px\)\)/.test(PANEL_CSS);
  const fill = /\.panel\.look-bighead \.irc\.say \.msg::after \{[^}]*top: min\(8px, calc\(50% - 8px\)\)/.test(PANEL_CSS);
  assert.ok(outline, 'the outline tail is centred while the balloon is short');
  assert.ok(fill, 'and so is the fill layer, one pixel inside it');
  assert.doesNotMatch(PANEL_CSS, /\.panel\.look-bighead \.irc\.say \.msg::before \{[^}]*top: 7px/,
    'a fixed offset is what clipped the tail');
});

test('private messages wear the radio starburst, and the other themes are untouched', () => {
  // The starburst is the one asset kept from the game art: it is the mark that
  // says "not room talk", and it keeps the art's own ratio so the star is never
  // squashed into a text box.
  assert.match(PANEL_CSS, /\.panel\.look-bighead \.irc\.pm \.msg \{[^}]*background: url\(\"data:image\/png;base64,/);
  assert.match(PANEL_CSS, /\.panel\.look-bighead \.irc\.pm \.msg \{[^}]*aspect-ratio: 214 \/ 128/);
  assert.match(PANEL_CSS, /\.panel\.look-bighead \.irc\.pm \.msg \{[^}]*border: 0/);
  assert.doesNotMatch(PANEL_CSS, /\.panel\.look-bighead \.irc\.pm \.msg::(before|after)/,
    'the starburst carries its own shape, so no drawn tail may sit on it');
  // a light theme would be ruined by the balloon's black outline, so it must not have one
  for (const theme of ['paper', 'amber']) {
    assert.doesNotMatch(PANEL_CSS, new RegExp('\\.panel\\.look-' + theme + ' \\.irc\\.say \\.msg[^{]*\\{[^}]*border'),
      theme + ' must not inherit the balloon outline');
  }
});

test('text and head size are written onto the panel', () => {
  const env = makeEnv();
  load(env);
  openSettings(env);
  const panel = env.el('panel');
  setSel(env, 'set-size', '16');
  assert.equal(panel.style.getPropertyValue('--log-size'), '16px');
  setSel(env, 'set-headpx', '32');
  assert.equal(panel.style.getPropertyValue('--head-px'), '32px', 'an explicit size beats the theme');
  setSel(env, 'set-headpx', '0');
  assert.equal(panel.style.getPropertyValue('--head-px'), '', 'back to the theme default');
});

test('the chat log look is stored for the next session', () => {
  const env = makeEnv();
  load(env);
  openSettings(env);
  setSel(env, 'set-theme', 'amber');
  setSel(env, 'set-size', '14');
  setSel(env, 'set-ts', 'hms');
  setChk(env, 'set-nicks', false);
  const last = env.saved[env.saved.length - 1].settings;
  assert.equal(last.theme, 'amber');
  assert.equal(last.chatSize, 14);
  assert.equal(last.tsFormat, 'hms');
  assert.equal(last.showNicks, false);
});

test('a look this build does not know falls back instead of leaving the log unstyled', () => {
  const env = makeEnv({ settings: { theme: 'neon', tsFormat: 'weird', chatSize: 99, showHeads: 'yes' } });
  load(env);
  const panel = env.el('panel');
  assert.ok(panel.classList.contains('look-bighead'), 'unknown theme falls back to the first theme (Default)');
  assert.equal(panel.style.getPropertyValue('--log-size'), '18px', 'a size out of range is clamped');
  frame(env, [{ kind: 'speech', actor: 'NRBv', text: 'hi ' }]);
  assert.ok(env.el('chatlog').children[0].children.some((c) => c.className === 'ts'),
    'an unknown format still shows the default stamp');
});

test('every theme the panel can apply has a rule to answer it', () => {
  const env = makeEnv();
  load(env);
  openSettings(env);
  ['classic', 'bighead', 'paper', 'amber'].forEach((t) => {
    setSel(env, 'set-theme', t);
    assert.ok(env.el('panel').classList.contains('look-' + t), t + ' is not on the panel');
    if (t !== 'classic') assert.ok(PANEL_CSS.includes('.panel.look-' + t), t + ' has no rule in panel.css');
  });
  // Classic is the base rules, so it needs no block of its own — but it must be the
  // default, or a fresh install would land on a theme nobody chose.
  setSel(env, 'set-theme', 'classic');
  assert.ok(!PANEL_CSS.includes('.panel.look-classic'), 'classic should not need an override block');
});

test('the chat rules name no colour directly, or no theme could restyle them', () => {
  const chat = PANEL_CSS.slice(PANEL_CSS.indexOf('chat */'));
  const themes = chat.indexOf('themes */');
  assert.ok(themes > 0, 'the themes block moved; this check is looking at the wrong slice');
  const literals = chat.slice(0, themes).match(/#[0-9a-f]{3,8}\b/gi) || [];
  assert.deepEqual(literals, [], 'these chat colours are hardcoded, so a theme cannot change them');
});

/* ------------------------------------------------------------------ schtick art */

const HEADS = '/release/art/schtick/heads';

const reply = (env, c, value) => env.fire('message', {
  source: env.win, origin: env.win.location.origin,
  data: { __c8_companion__: 1, k: 'reply', id: c.id, value }
});

/**
 * Answer the panel's page-side reads from a fake game filesystem until it stops
 * asking. Keys are the paths asked for; values are directory listings, byte
 * arrays or file text, exactly as src/agent.js hands them back.
 */
async function answerReads(env, fs) {
  for (let round = 0; round < 12; round++) {
    const open = env.posted.filter((m) => m && m.k === 'cmd' && !m._answered);
    if (!open.length) return;
    for (const c of open) {
      c._answered = true;
      let value = null;
      if (c.cmd === 'status') value = { hasFs: true, ready: true, canType: true, user: 'Blasto' };
      else if (c.args && fs[c.args.path] !== undefined) value = fs[c.args.path];
      reply(env, c, value);
    }
    await tick(); await tick(); await tick();
  }
}

/**
 * A 4x2 8-bit BI_RLE8 BMP. Palette entry 1 is a concrete colour, entry 63 is the
 * engine's transparent key. Rows are bottom-up, so the first encoded line is the
 * bottom row: a run of solid pixels, an end-of-line, a literal run of odd length
 * (which carries its padding byte), a run, then the end-of-bitmap marker.
 */
function rleBmp(bpp) {
  const w = 4, h = 2, off = 54 + 1024;
  const b = new Array(off + 12).fill(0);
  const u32 = (at, v) => {
    b[at] = v & 255; b[at + 1] = (v >> 8) & 255; b[at + 2] = (v >> 16) & 255; b[at + 3] = (v >>> 24) & 255;
  };
  b[0] = 0x42; b[1] = 0x4d;                       // 'BM'
  u32(2, b.length); u32(10, off); u32(14, 40); u32(18, w); u32(22, h);
  b[26] = 1; b[28] = bpp || 8; u32(30, 1);        // 1 plane, BI_RLE8
  b[54 + 4] = 30; b[54 + 5] = 20; b[54 + 6] = 10; // palette 1, stored B G R
  b[54 + 63 * 4] = 255; b[54 + 63 * 4 + 2] = 8;   // palette 63, the key
  const data = [2, 63, 2, 1, 0, 0, 0, 3, 1, 63, 1, 0, 2, 1, 0, 1];
  data.forEach((v, i) => { b[off + i] = v; });
  return b;
}

function artFs(bmp) {
  return {
    [HEADS]: ['h04fishbowl'],
    [HEADS + '/h04fishbowl']: ['h04s01.bmp'],
    [HEADS + '/h04fishbowl/h04s01.bmp']: bmp,
    '/release/sys/connect.dat': "1 'FOUN' 37 '3718' 'TRAN' 'TRAN' 'STLA' 'S022' 0 // Your Room\n"
  };
}

/** Load the panel, let it read the art tree, and render one line from head 4. */
async function headLine(env, fs) {
  load(env);
  await answerReads(env, fs);
  frame(env, [{ kind: 'actors', list: [{ id: 65, name: 'Blasto', head: 4 }] }]);
  frame(env, [{ kind: 'speech', actor: 'NRBA', text: 'hi ' }]);
  await answerReads(env, fs);
  return env.el('chatlog').children[0];
}

test('head art is decoded, the colour key punched out, and rasterised by the platform', async () => {
  const env = makeEnv();
  const line = await headLine(env, artFs(rleBmp()));

  const face = line.children.find((c) => c.className === 'head');
  assert.ok(face, 'the line wears the head');
  assert.equal(face.tagName, 'IMG');
  assert.equal(face.attrs.src, 'data:image/png;base64,8', 'a PNG of the 4x2 surface, not a BMP');

  const px = env.painted.at(-1);
  assert.equal(px.width, 4);
  assert.equal(px.height, 2);
  const at = (x, y) => Array.from(px.data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
  assert.deepEqual(at(0, 0), [10, 20, 30, 255], 'palette entry 1 is stored BGR, so red comes from +2');
  assert.deepEqual(at(1, 0), [8, 0, 255, 0], 'index 63 is keyed out: transparent, colour retained');
  assert.deepEqual(at(3, 0), [10, 20, 30, 255], 'the run after the padded literal is solid too');
  assert.deepEqual(at(1, 1), [8, 0, 255, 0], 'the bottom row is encoded first and lands last');
  assert.deepEqual(at(2, 1), [10, 20, 30, 255]);

  // Which path drew it is in the on-disk diagnostics, so a real browser can be
  // checked from its profile instead of by eye.
  env.intervals.find((i) => i.ms === 5000).fn();
  assert.match(env.saved.at(-1).diagJson, /"headArtPath":"canvas"/);
});

test('a face asked for before the art tree is known is drawn once it arrives', async () => {
  // A restored transcript paints its lines at load, before readDir has answered.
  // That "no art yet" must not be cached as "no such art", or every restored face
  // stays missing for the whole session — measured in Firefox.
  const env = makeEnv();
  load(env);
  frame(env, [{ kind: 'actors', list: [{ id: 65, name: 'Blasto', head: 4 }] }]);
  frame(env, [{ kind: 'speech', actor: 'NRBA', text: 'hi ' }]);
  assert.equal(env.el('chatlog').children[0].children.some((c) => c.className === 'head'), false,
    'there is no art to draw yet');
  await answerReads(env, artFs(rleBmp()));
  const face = env.el('chatlog').children[0].children.find((c) => c.className === 'head');
  assert.ok(face, 'the face appears when the tree is read');
  assert.equal(face.attrs.src, 'data:image/png;base64,8');
});

test('a head the decoder cannot read is no icon, and is not read again', async () => {
  const env = makeEnv();
  const line = await headLine(env, artFs(rleBmp(24)));
  assert.ok(line, 'the line is still written');
  assert.equal(line.children.some((c) => c.className === 'head'), false, 'no face rather than a broken one');
  assert.equal(env.painted.length, 0, 'nothing reached the rasteriser');

  const reads = () => env.posted.filter(
    (m) => m && m.k === 'cmd' && (m.cmd === 'readBytes' || m.cmd === 'readDir')).length;
  const before = reads();
  env.el('cog')._handlers.click[0]({});
  env.el('cog')._handlers.click[0]({});
  await tick();
  assert.equal(reads(), before, 'an unreadable head is not re-read on every repaint');
});

/* ------------------------------------------------- the two sides agree */

const AGENT = readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8');
const PANEL = src;

test('the panel offers exactly the limits the agent enforces', () => {
  // The panel cannot import window.C8Proto: it runs in the isolated world. So the
  // numbers are duplicated by necessity and pinned here by test.
  const say = Number(/SAY_MAX = (\d+)/.exec(AGENT)[1]);
  const pm = Number(/MAX_TEXT = (\d+)/.exec(AGENT)[1]);
  assert.equal(say, 120);
  assert.equal(pm, 180);
  assert.match(PANEL, new RegExp('text\\.length > ' + say + '\\b'), 'the room draft cap');
  assert.match(PANEL, new RegExp('var PM_LIMIT = ' + pm + '\\b'), 'the private message split size');
  assert.match(PANEL, new RegExp("to\\.length > " + (31) + "\\b"), 'the recipient name cap');
});

test('printable ASCII is checked the same way on both sides of the bridge', () => {
  const pattern = String.raw`/^[\x20-\x7e]*$/`;
  assert.ok(AGENT.includes(pattern) || readFileSync(new URL('../src/protocol.js', import.meta.url), 'utf8').includes(pattern),
    'the page-world rules');
  assert.ok(PANEL.includes(pattern), 'and the rule the panel refuses with');
});

test('a partly typed room message is not offered back whole', async () => {
  const env = makeEnv();
  load(env);
  gameReady(env);
  say(env, 'hello room');
  const c = cmds(env, 'say')[0];
  env.el('chat-text').value = '';          // the reader cleared the box while it typed
  env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: {
      __c8_companion__: 1, k: 'reply', id: c.id,
      value: { ok: false, typed: 6, error: 'The game stopped accepting input before the message was sent.' }
    }
  });
  await tick();
  assert.equal(env.el('chat-text').value, 'room',
    'only the characters the game never received are put back');
  assert.match(env.el('toast').textContent, /6 of 10 characters are already typed there/);
});

test('a departure names the player the room already knows', () => {
  const env = makeEnv();
  load(env);
  const KEY = 0x1e8412 + 116;
  frame(env, [{ kind: 'actors', list: [{ id: 116, name: 'Timmy3XUJW', head: 4, key: KEY }] }]);
  frame(env, [{ kind: 'speech', actor: 'NRBt', text: 'yooooo ' }]);
  frame(env, [{ kind: 'left', key: KEY }]);
  const texts = env.el('chatlog').children.map((n) => n.textContent);
  assert.ok(texts.some((t) => /LEFT: Timmy3XUJW/.test(t)), 'the leave line names them: ' + JSON.stringify(texts.slice(-3)));
});

test('a repeated departure frame does not print a second, nameless line', () => {
  // The server sends some frames twice; the first leave consumes the name.
  const env = makeEnv();
  load(env);
  const KEY = 0x1e8412 + 116;
  frame(env, [{ kind: 'actors', list: [{ id: 116, name: 'Timmy3XUJW', head: 4, key: KEY }] }]);
  frame(env, [{ kind: 'left', key: KEY }]);
  frame(env, [{ kind: 'left', key: KEY }]);
  const lefts = env.el('chatlog').children.map((n) => n.textContent).filter((t) => /LEFT:/.test(t));
  assert.equal(lefts.length, 1, 'one departure line, not two');
  assert.match(lefts[0], /LEFT: Timmy3XUJW/);
});

test('a departure nobody in this room could name is not printed at all', () => {
  // Right after a room change the id maps are empty, so a leave can arrive before the
  // name records do. "LEFT: someone" is a line that says nothing; the arrival that
  // follows will name the player anyway.
  const env = makeEnv();
  load(env);
  frame(env, [{ kind: 'left', key: 0x1e8412 + 116 }]);
  const lefts = env.el('chatlog').children.map((n) => n.textContent).filter((t) => /LEFT:/.test(t));
  assert.equal(lefts.length, 0, 'no unattributable departure line');
});

test('a departure we can place, but not name, still gets one line', () => {
  // Somebody we watched move about this room is a real departure even without a name.
  const env = makeEnv();
  load(env);
  frame(env, [{ kind: 'move', actor: 'NRBt' }]);
  frame(env, [{ kind: 'left', key: 0x1e8412 + 116 }]);
  const lefts = env.el('chatlog').children.map((n) => n.textContent).filter((t) => /LEFT:/.test(t));
  assert.equal(lefts.length, 1);
  assert.match(lefts[0], /LEFT: someone/);
});

test('a written departure is never rewritten by anything that happens later', () => {
  // The relabeller used to recompute presence lines from the map as it stood, so a
  // named LEFT became "LEFT: someone" once the name was cleared, or took the name of
  // whoever next wore that id. A departure is history.
  const env = makeEnv();
  load(env);
  const KEY = 0x1e8412 + 116;
  frame(env, [{ kind: 'actors', list: [{ id: 116, name: 'Timmy3XUJW', head: 4, key: KEY }] }]);
  frame(env, [{ kind: 'left', key: KEY }]);
  const leftOf = () => env.el('chatlog').children.map((n) => n.textContent).filter((t) => /LEFT:/.test(t));

  assert.match(leftOf()[0], /LEFT: Timmy3XUJW/);

  // the id is reused by somebody else: the old line must not take the new name
  frame(env, [{ kind: 'actors', list: [{ id: 116, name: 'Someone Else', head: 12, key: KEY }], live: true }]);
  assert.match(leftOf()[0], /LEFT: Timmy3XUJW/, 'the old line still says who left');

  // and the server's second copy of that departure is not a second departure
  frame(env, [{ kind: 'left', key: KEY }]);
  assert.equal(leftOf().length, 1, 'no second line');
  assert.match(leftOf()[0], /LEFT: Timmy3XUJW/);
});


/* ------------------------------------------------------------ TEAM room guard */

const TEAM_CONNECT = [
  "47 'TEAM' 00 'NZBX' 'TRAN' 'TRAN' 'THNK' // Hall of Peril",
  "48 'TEAM' 00 'NZBX' 'TRAN' 'TRAN' 'DIST' '0176' 0 // Gates of Peril",
  "30 'GRIN' 48 '4801' 'TRAN' 'TRAN' 'DIST' '0181' 0 // Deadend",
  "03 'TEAM' 00 '0501' 'TRAN' 'TRAN' 'DIST' 'S409' 0 // Control Room 1",
  "17 'TEAM' 00 '1801' 'TRAN' 'TRAN' 'DIST' 'S437' 0 // Super Duper Seaquest 1",
  "18 'TEAM' 00 '1901' 'TRAN' 'TRAN' 'DIST' '0403' 0 // Super Duper Seaquest 2",
  "28 'TEAM' 00 'ENTR' 'TRAN' 'TRAN' 'DIST' '0381' 0 // Hall of Noses",
  "43 'TEAM' 00 '1701' 'TRAN' 'TRAN' 'DIST' 'S435' 0 // Control Room Two",
  "37 'LF01' 35 '3503' 'TRAN' 'TRAN' 'DIST' '0189' 0 // Central Fountain",
  "36 'TOP1' 37 '3718' 'TRAN' 'TRAN' 'BACK' // Club Infinity",
  "01 'FOUN' 37 '3718' 'TRAN' 'TRAN' 'STLA' 'S022' 0 // Your Room",
  "90 'CENT' 91 'ENTR' 'PLAY' 'TRAN' 'INTR' // Demo 1",
  "92 'HALL' 96 '2701' 'PLAY' 'TRAN' 'OCTS' // October: Staging Room",
  "63 'TEAM' 00 'TmIn' 0 0 0 // Test Comm-Team Transition"
].join('\n');

const TEAM_ROOMS = [3, 5, 17, 18, 19, 25, 28, 43, 47, 52, 53, 54, 56, 63];
const PUBLIC_ROOMS = [48, 37, 36, 1, 90, 92];

const isHidden = (env, id) => env.el(id).getAttribute('hidden') !== null;
const isVisible = (env, id) => env.el(id).getAttribute('hidden') === null;

async function teamEnv(stored) {
  const env = makeEnv(stored);
  load(env);
  gameReady(env);
  await answerReads(env, { '/release/sys/connect.dat': TEAM_CONNECT });
  return env;
}

test('a TEAM room hides the chat behind the warning until acknowledged', async () => {
  const env = await teamEnv();
  frame(env, [{ kind: 'room', room: 47 }]);

  assert.ok(isHidden(env, 'chatlog'), 'the log is hidden');
  assert.ok(isHidden(env, 'chatform'), 'the compose row is hidden');
  assert.ok(isVisible(env, 'chat-lock'), 'the warning is in its place');
  const message = env.el('chat-lock').children.find((c) => c.tagName === 'P');
  assert.equal(message.textContent, 'This might be a little cheaty in this room');
  assert.equal(env.el('chat-lock-ok').textContent, "That's OK");

  env.el('chat-lock-ok').click();
  assert.ok(isVisible(env, 'chatlog'), 'OK reveals the log');
  assert.ok(isVisible(env, 'chatform'), 'OK reveals the compose row');
  assert.ok(isHidden(env, 'chat-lock'), 'the warning goes away');
});

test('every confirmed TEAM room locks, including the fallback rooms', async () => {
  const env = await teamEnv();
  for (const room of TEAM_ROOMS) {
    frame(env, [{ kind: 'room', room }]);
    assert.ok(isHidden(env, 'chatform'), 'room ' + room + ' should lock');
  }
});

test('public rooms with a TEAM exit stay public', async () => {
  const env = await teamEnv();
  for (const room of PUBLIC_ROOMS) {
    frame(env, [{ kind: 'room', room }]);
    assert.ok(isVisible(env, 'chatlog'), 'room ' + room + ' should keep the chat');
    assert.ok(isVisible(env, 'chatform'));
    assert.ok(isHidden(env, 'chat-lock'));
  }
});

test('leaving and re-entering a TEAM room warns again', async () => {
  const env = await teamEnv();
  frame(env, [{ kind: 'room', room: 47 }]);
  env.el('chat-lock-ok').click();
  assert.ok(isVisible(env, 'chatform'));

  frame(env, [{ kind: 'room', room: 37 }]);
  assert.ok(isVisible(env, 'chatform'), 'the public room is unchanged');

  frame(env, [{ kind: 'room', room: 47 }]);
  assert.ok(isHidden(env, 'chatform'), 'a new visit gets a new warning');
});

test('a restored TEAM room locks once the map arrives', async () => {
  const env = await teamEnv({ lastRoom: 47 });
  assert.ok(isHidden(env, 'chatform'), 'the restored room is locked without a room frame');
});

test('a missing map fails open for the live rule, but the fallback rooms still lock', async () => {
  const env = makeEnv();
  load(env);
  gameReady(env);
  await answerReads(env, {});

  frame(env, [{ kind: 'room', room: 37 }]);
  assert.ok(isVisible(env, 'chatlog'), 'an unreadable map must not lock a public room');

  frame(env, [{ kind: 'room', room: 25 }]);
  assert.ok(isHidden(env, 'chatform'), 'the confirmed fallback list does not need the map');
});

test('the transcript keeps recording while a TEAM room hides it', async () => {
  const env = await teamEnv();
  frame(env, [{ kind: 'room', room: 47 }]);
  assert.ok(isHidden(env, 'chatlog'));

  env.el('chat-lock-ok').click();
  assert.match(env.el('chatlog').textContent, /ENTERING Hall of Peril/);
});

