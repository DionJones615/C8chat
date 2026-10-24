/**
 * Agent tests.
 *
 * src/agent.js runs in the page's own JS context, so this loads it against a
 * minimal stub. The thing worth guarding is the key recorder: it listens at
 * window-capture, which fires before the panel's shadow-boundary guard, so
 * without an explicit check the user typing in the chat box would be captured
 * as a routine and later replayed into the game.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const protoSrc = readFileSync(new URL('../src/protocol.js', import.meta.url), 'utf8');
const agentSrc = readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8');

function makeEnv(staleAgent) {
  const winHandlers = {};
  const timers = [];
  const prototypeSends = [];
  const posted = [];

  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 1; this.listeners = {}; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    emit(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev)); }
    send(data) { prototypeSends.push({ socket: this, data }); }
  }

  const host = { id: 'c8-chat-host', tagName: 'DIV' };
  const input = { tagName: 'INPUT' };
  const shadow = { tagName: '#shadow' };

  class PageWS extends FakeWS {}
  const win = {
    location: { origin: 'https://www.castleinfinity.com', href: 'https://www.castleinfinity.com/' },
    WebSocket: PageWS,
    Module: { arguments: [], _c8_inject_key() {}, _c8_inject_text_key() {} },
    FS: null,
    addEventListener: (t, fn) => { (winHandlers[t] = winHandlers[t] || []).push(fn); },
    removeEventListener: () => {},
    postMessage: (msg) => posted.push(msg)
  };
  win.window = win;
  if (staleAgent) win.__c8CompanionAgentInstalled = true;   // a pre-rename build

  const document = {
    getElementById: (id) => (id === 'c8-chat-host' ? host : null),
    addEventListener: () => {}
  };

  const ctx = vm.createContext({
    window: win,
    document,
    location: win.location,
    localStorage: { getItem: () => null, setItem: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, ms) => { const timer = { fn: fn, ms: ms }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timer.cleared = true; },
    console,
    Date,
    performance: { now: () => 0 },
    TextDecoder,
    Uint8Array,
    ArrayBuffer
  });
  ctx.globalThis = ctx;

  vm.runInContext(protoSrc, ctx);
  vm.runInContext(agentSrc, ctx);

  const fire = (type, ev) => (winHandlers[type] || []).forEach((fn) => fn(ev));
  const cmd = (name, args, source = win, origin = win.location.origin) => fire('message', {
    source, origin,
    data: { __c8_chat__: 1, k: 'cmd', id: 1, cmd: name, args }
  });
  const keyMsgs = () => posted.filter((m) => m && m.k === 'key');
  return { ctx, win, host, input, shadow, fire, cmd, keyMsgs, posted, prototypeSends, timers, runNextTimer(ms) { const timer = timers.find((t) => !t.ran && !t.cleared && t.ms === ms); if (!timer) return false; timer.ran = true; timer.fn(); return true; } };
}

/** A keydown originating from inside the extension's shadow root. */
const fromPanel = (env, key) => ({
  key,
  target: env.host,
  composedPath: () => [env.input, env.shadow, env.host, env.win.document]
});

/** A keydown from the page at large. */
const fromPage = (env, key) => ({
  key,
  target: { tagName: 'CANVAS' },
  composedPath: () => [{ tagName: 'CANVAS' }, env.win.document]
});

test('a retained pre-rename agent is relayed, not doubled', () => {
  const env = makeEnv(true);
  assert.equal(env.win.__c8ChatAgentInstalled, true);
  assert.notEqual(env.win.WebSocket.__c8wrapped, true, 'the retained wrapper stays the only one');

  env.cmd('status', {});
  const cmd = env.posted.find((m) => m && m.k === 'cmd');
  assert.equal(cmd.__c8_chat__, 1, 'the panel speaks the new name');
  assert.equal(cmd.__c8_companion__, 1, 'and the retained agent hears the old one');

  env.fire('message', {
    source: null, origin: env.win.location.origin,
    data: { __c8_companion__: 1, k: 'reply', id: cmd.id, ok: true, value: { ready: true } }
  });
  const replies = env.posted.filter((m) => m && m.k === 'reply');
  assert.equal(replies.length, 1, 'exactly one relayed reply');
  assert.equal(replies[0].__c8_chat__, 1, 'the reply comes back under the new name');

  env.fire('message', {
    source: null, origin: env.win.location.origin,
    data: { __c8_companion__: 1, k: 'frame', frame: { t: 1 } }
  });
  const frames = env.posted.filter((m) => m && m.k === 'frame');
  assert.equal(frames.length, 1, 'exactly one relayed frame');
  assert.equal(frames[0].__c8_chat__, 1);
});

test('reinjection leaves one MAIN-world command listener and one WebSocket wrapper', () => {
  const env = makeEnv();
  const wrapped = env.win.WebSocket;
  vm.runInContext(agentSrc, env.ctx);
  assert.equal(env.win.WebSocket, wrapped, 'second injection must preserve the first wrapper');
  assert.equal((env.ctx.window && env.ctx.window.__c8ChatAgentInstalled), true);
  const before = env.posted.length;
  env.cmd('status', {});
  assert.equal(env.posted.slice(before).filter((m) => m && m.k === 'reply').length, 1);
});

test('the agent accepts same-origin extension messages with Firefox null source', () => {
  const env = makeEnv();
  env.cmd('status', {}, null);
  assert.ok(env.posted.some((m) => m && m.k === 'reply'), 'null-source status command was ignored');

  const before = env.posted.length;
  env.cmd('status', {}, {}, env.win.location.origin);
  env.cmd('status', {}, null, 'https://attacker.example');
  assert.equal(env.posted.length, before, 'foreign windows and origins must be ignored');

  env.cmd('status', {});
  assert.equal(env.posted.filter((m) => m && m.k === 'reply').length, 2, 'Chromium same-window messages still work');
});

test('recording captures keys pressed in the game', () => {
  const env = makeEnv();
  env.cmd('record', { on: true });
  env.fire('keydown', fromPage(env, 'ArrowRight'));
  env.fire('keydown', fromPage(env, 'a'));
  const msgs = env.keyMsgs();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].sc, 79, 'ArrowRight scancode');
  assert.equal(msgs[1].sc, 4, 'a scancode');
  assert.equal(msgs[1].text, 'a');
});

test('recording ignores keys typed into the extension UI', () => {
  const env = makeEnv();
  env.cmd('record', { on: true });
  env.fire('keydown', fromPanel(env, 'h'));
  env.fire('keyup', fromPanel(env, 'h'));
  env.fire('keydown', fromPanel(env, 'ArrowRight'));
  assert.equal(env.keyMsgs().length, 0, 'typing in the chat box must not be recorded');

  // and the page still records normally afterwards
  env.fire('keydown', fromPage(env, 'ArrowUp'));
  assert.equal(env.keyMsgs().length, 1);
  assert.equal(env.keyMsgs()[0].sc, 82);
});

test('room say rejects unavailable input and Unicode before injecting any key', async () => {
  const env = makeEnv();
  env.win.Module = { arguments: [], _c8_inject_key() {}, _c8_inject_text_key() {} };
  const send = (text, id) => env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: { __c8_chat__: 1, k: 'cmd', id: id, cmd: 'say', args: { text: text } }
  });

  env.win.Module._c8_inject_text_key = null;
  send('hello', 11);
  assert.deepEqual(JSON.parse(JSON.stringify(env.posted.filter((m) => m && m.k === 'reply').pop().value)), {
    ok: false, typed: 0, error: 'The game is still loading; your message was not sent.'
  });

  let injected = 0;
  env.win.Module._c8_inject_text_key = () => { injected++; };
  send('caf\u00e9', 12);
  assert.equal(env.posted.filter((m) => m && m.k === 'reply').pop().value.ok, false);
  assert.equal(env.posted.filter((m) => m && m.k === 'reply').pop().value.typed, 0);
  assert.equal(injected, 0, 'invalid Unicode must be rejected before touching the game');
});

test('the agent reports only actually injected characters and serializes public sends', async () => {
  const env = makeEnv();
  const injected = [];
  env.win.Module._c8_inject_text_key = (sc, shift) => {
    injected.push([sc, shift]);
  };
  const fireCmd = (id, text) => env.fire('message', {
    source: env.win, origin: env.win.location.origin,
    data: { __c8_chat__: 1, k: 'cmd', id: id, cmd: 'say', args: { text: text } }
  });

  fireCmd(21, 'ab');
  fireCmd(22, 'cd');
  assert.deepEqual(injected, [[4, 0]], 'only the first message starts injecting');
  const replies = () => env.posted.filter((m) => m && m.k === 'reply');
  assert.deepEqual(replies().map((m) => m.value.error), ['A room message is already being sent. Please wait.']);
  assert.equal(env.runNextTimer(130), true, 'first character schedules the next step');
  assert.deepEqual(injected, [[4, 0], [5, 0]], 'second character arrives on the first delay');
  assert.equal(env.runNextTimer(130), true, 'agent waits for one idle delay before committing');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(injected, [[4, 0], [5, 0]], 'first message is typed completely and in order');
  const first = replies().find((m) => m.id === 21);
  assert.deepEqual(JSON.parse(JSON.stringify(first.value)), { ok: true, typed: 2 });
});

test('nothing is recorded while recording is off', () => {
  const env = makeEnv();
  env.fire('keydown', fromPage(env, 'a'));
  assert.equal(env.keyMsgs().length, 0);
  env.cmd('record', { on: false });
  env.fire('keydown', fromPage(env, 'a'));
  assert.equal(env.keyMsgs().length, 0);
});

test('the agent never forwards the account key', () => {
  const env = makeEnv();
  // stand in for page Module.arguments, which carries -vorticopass <key>
  env.win.Module = { arguments: ['-vorticouser', 'Blasto', '-vorticopass', 'HYPCDCJGBSYKGE2'], _c8_inject_key() {}, _c8_inject_text_key() {} };
  env.cmd('status', {});
  const reply = env.posted.find((m) => m && m.k === 'reply');
  assert.ok(reply, 'no status reply');
  assert.equal(reply.value.user, 'Blasto');
  assert.equal(reply.value.hasFs, false);
  const dumped = JSON.stringify(env.posted);
  assert.equal(dumped.includes('HYPCDCJGBSYKGE2'), false, 'account key leaked into a message');
});

test('a decoded speech frame keeps the actor tag that separates speakers', () => {
  const env = makeEnv();
  // a real inbound frame, captured live: "NRBv" (Helpbot) says "hi "
  const hex = '16 71 01 00 20 4e 52 42 76 00 0d 00 8d 57 44 44 41 03 00 68 69 20';
  const sock = new env.win.WebSocket('ws://www.castleinfinity.com:8173/');
  sock.emit('message', {
    data: Uint8Array.from(hex.split(' ').map((h) => parseInt(h, 16)))
  });

  const posted = env.posted.find((m) => m && m.k === 'frame');
  assert.ok(posted, 'no frame posted');
  const d = posted.frame.decoded[0];
  assert.equal(d.kind, 'speech');
  assert.equal(d.text, 'hi ');
  // Dropping this field merged every speaker into one buffer in the chat box.
  assert.equal(d.actor, 'NRBv');
});

test('the MAIN-world WebSocket tap reports speech and calls native send once', () => {
  const env = makeEnv();
  const sock = new env.win.WebSocket('ws://www.castleinfinity.com:9001/');
  // real bytes: an outbound 0x00 frame captured while typing into the game
  sock.send(Uint8Array.from('17 71 01 00 20 4e 52 42 77 00 0d 00 e7 57 44 44 41 03 00 68 69 20 00'
    .split(' ').map((h) => parseInt(h, 16))));

  const posted = env.posted.filter((m) => m && m.k === 'frame');
  assert.equal(posted.length, 1, 'outbound traffic must be teed');
  assert.equal(env.prototypeSends.length, 1, 'the original send must still run exactly once');
  env.cmd('status', {});
  const status = env.posted.filter((m) => m && m.k === 'reply').pop().value;
  assert.equal(status.sendHook, true, 'the tap saw the outgoing send');
  const f = posted[0].frame;
  assert.equal(f.dir, 'out');
  const d = f.decoded[0];
  assert.equal(d.kind, 'speech');
  assert.equal(d.actor, 'NRBw');
  assert.equal(d.text, 'hi ', 'scrub() must not mangle ordinary speech');
  assert.equal(f.dir, 'out', 'directly typed WASM speech remains observable for the chat log');
});

test('a room socket dropping is reported, and the metaserver is not', () => {
  const env = makeEnv();
  const room = new env.win.WebSocket('wss://baron.castleinfinity.com:443/?target=10000');
  const meta = new env.win.WebSocket('wss://vortico.castleinfinity.com:443/?target=1776');

  room.emit('close');
  meta.emit('close');
  const socks = () => env.posted.filter((m) => m && m.k === 'sock');
  assert.equal(socks().length, 1, 'the room socket, and only it');
  assert.equal(socks()[0].ev, 'closed');
  assert.equal(socks()[0].target, 10000);

  // an error followed by the close is one outage; the panel is what dedupes them,
  // because only it knows whether the socket closed to move rooms or to go offline
  room.emit('error');
  assert.equal(socks().length, 2);
});

test('the game\'s art is read out of its own filesystem, bytes and all', () => {
  const env = makeEnv();
  const files = {
    '/release/art/schtick/heads': ['h01balloon', 'h16potato'],
    '/release/art/schtick/heads/h01balloon': ['h01s01.bmp', 'h01s02.bmp']
  };
  env.win.FS = {
    readFile: (p) => {
      if (p === '/release/art/schtick/heads/h01balloon/h01s01.bmp') return new Uint8Array([0x42, 0x4d, 0x98]);
      throw new Error('ENOENT');
    },
    readdir: (p) => {
      if (!files[p]) throw new Error('ENOENT');
      return ['.', '..'].concat(files[p]);
    }
  };

  env.cmd('readBytes', { path: '/release/art/schtick/heads/h01balloon/h01s01.bmp' });
  const bytes = env.posted.find((m) => m && m.k === 'reply').value;
  assert.deepEqual(Array.from(bytes), [0x42, 0x4d, 0x98]);

  env.cmd('readDir', { path: '/release/art/schtick/heads' });
  const dirs = env.posted.filter((m) => m && m.k === 'reply').pop().value;
  assert.deepEqual(Array.from(dirs), ['h01balloon', 'h16potato'], 'the dot entries are not art');
});

test('the page is asked to re-run its canvas fit on demand', () => {
  const env = makeEnv();
  let calls = 0;
  env.win.c8LayoutGameCanvas = () => { calls++; };

  env.cmd('layout', {});
  let reply = env.posted.filter((m) => m && m.k === 'reply').pop();
  assert.equal(reply.ok, true);
  assert.equal(reply.value, true, 'the hook ran');
  assert.equal(calls, 1);

  delete env.win.c8LayoutGameCanvas;
  env.cmd('layout', {});
  reply = env.posted.filter((m) => m && m.k === 'reply').pop();
  assert.equal(reply.ok, true, 'a page without the hook is not an error');
  assert.equal(reply.value, false, 'and it says the fit could not be run');
});

test('a missing file or a missing filesystem is null, never a throw', () => {
  const env = makeEnv();
  env.cmd('readBytes', { path: '/nope' });
  assert.equal(env.posted.find((m) => m && m.k === 'reply').value, null, 'no FS at all');

  env.win.FS = { readFile: () => { throw new Error('ENOENT'); }, readdir: () => { throw new Error('ENOENT'); } };
  env.cmd('readBytes', { path: '/nope' });
  env.cmd('readDir', { path: '/nope' });
  const replies = env.posted.filter((m) => m && m.k === 'reply');
  assert.equal(replies[replies.length - 1].value, null);
  assert.equal(replies[replies.length - 2].value, null);
});

test('a synthesised press is held down for a moment, not tapped in one tick', () => {
  // The client samples the keyboard once a frame. A down and an up in the same tick
  // is how the face ask went out and nothing came back.
  const env = makeEnv();
  const injected = [];
  env.win.Module._c8_inject_key = (sc, down) => { injected.push([sc, down]); };
  env.cmd('press', { sc: 75 });
  assert.deepEqual(injected, [[75, 1]], 'the key goes down immediately');
  assert.equal(env.runNextTimer(60), true, 'and is released on a timer');
  assert.deepEqual(injected, [[75, 1], [75, 0]], 'so the game sees a real keypress');
});
