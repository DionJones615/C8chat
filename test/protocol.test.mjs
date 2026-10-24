import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/protocol.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(src, ctx);
const P = ctx.C8Proto;

const bytes = (hex) => Uint8Array.from(hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));

/* Real captures from the live game. */

// keepalive: the 4-byte payload is echoed back verbatim by the server.
const KEEPALIVE = '08 71 01 0b e1 d7 94 46';
// client sync, empty payload
const SYNC = '04 71 01 06';
// opcode 0x18
const OP18 = '0a 71 01 18 0f 00 34 00 15 00';
// opcode 0x16 carrying a 4-char code and a u32
const URC = '0c 71 01 16 2f 55 52 43 06 00 00 00';
// first chunk of the sector list (type 0x14)
const SECTOR_MSG = '14 71 01 14 00 00 00 00 01 00 00 00 4c 4d 57 4e 01 00 00 00';
// metaserver greeting, length-prefixed string
const GREET = '23 71 08 04 12 10 00 e0 00 00 00 00 16 50 68 61 73 65 20 32 20 64 65 76 20 6d 65 74 61 73 65 72 76 65 72';

test('declared length matches the actual byte count of the captures', () => {
  for (const hex of [KEEPALIVE, SYNC, OP18, URC, SECTOR_MSG, GREET]) {
    const b = bytes(hex);
    assert.equal(b[0], b.length, `len byte ${b[0]} != ${b.length} for ${hex.slice(0, 8)}`);
    assert.equal(b[1], 0x71);
  }
});

test('splitFrames decodes a single keepalive message', () => {
  const msgs = P.splitFrames(bytes(KEEPALIVE));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].channel, 0x01);
  assert.equal(msgs[0].channelName, 'sip');
  assert.equal(msgs[0].type, 0x0b);
  assert.equal(msgs[0].name, 'keepalive');
  assert.deepEqual([...msgs[0].payload], [0xe1, 0xd7, 0x94, 0x46]);
});

test('splitFrames handles empty and short payloads', () => {
  const sync = P.splitFrames(bytes(SYNC))[0];
  assert.equal(sync.type, 0x06);
  assert.equal(sync.payload.length, 0);

  const op18 = P.splitFrames(bytes(OP18))[0];
  assert.equal(op18.type, 0x18);
  assert.equal(op18.payload.length, 6);
});

test('splitFrames walks several concatenated messages in one frame', () => {
  const joined = new Uint8Array([...bytes(SECTOR_MSG), ...bytes(URC)]);
  const msgs = P.splitFrames(joined);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].name, 'sector-list');
  assert.equal(msgs[1].name, 'sector-query');
  assert.equal(P.ascii(msgs[1].payload, 0, 4), '/URC');
});

test('splitFrames distinguishes the SIP and ILP channels', () => {
  // Same opcode 0x01, different channel: in-game enter vs metaserver login.
  const sip = P.splitFrames(bytes('08 71 01 01 10 00 0c 00'))[0];
  const ilp = P.splitFrames(bytes('0a 71 08 01 42 6c 61 73 74 6f 00'))[0];
  assert.equal(sip.type, ilp.type);
  assert.equal(sip.channelName, 'sip');
  assert.equal(ilp.channelName, 'ilp');
  assert.equal(P.fstr(ilp.payload, 0, 6), 'Blasto');
});

test('splitFrames flags a bad length instead of desynchronising', () => {
  const bad = P.splitFrames(new Uint8Array([0x02, 0x71, 0x01, 0xff]));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].bad, true);
  assert.equal(bad[0].name, 'raw');
});

test('splitFrames flags a truncated trailing message', () => {
  const truncated = P.splitFrames(new Uint8Array([0x40, 0x71, 0x01, 0x00, 0x00]));
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0].bad, true);
});

test('printable pulls the greeting text out of the payload', () => {
  const greet = P.splitFrames(bytes(GREET))[0];
  assert.equal(greet.channelName, 'ilp');
  assert.equal(greet.type, 0x04);
  assert.ok(P.printable(greet.payload).includes('Phase 2 dev metaserver'));
});

test('fstr reads a fixed-width NUL-padded field', () => {
  const field = new Uint8Array(16);
  field.set([...'Blasto'].map((c) => c.charCodeAt(0)), 0);
  assert.equal(P.fstr(field, 0, 16), 'Blasto');

  const full = new Uint8Array(16).fill(0x41);
  assert.equal(P.fstr(full, 0, 16), 'AAAAAAAAAAAAAAAA');
});

// protocol.js runs in a separate vm realm, so its objects have a different
// prototype; compare structurally.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('sectorEntries decodes 4-char codes with u32 values', () => {
  const payload = new Uint8Array([
    0x30, 0x30, 0x30, 0x48, 0x07, 0x00, 0x00, 0x00, // "000H", 7
    0x30, 0x32, 0x30, 0x48, 0xa5, 0x00, 0x00, 0x00  // "020H", 165
  ]);
  assert.deepEqual(plain(P.sectorEntries(payload)), [
    { code: '000H', value: 7 },
    { code: '020H', value: 165 }
  ]);
});

/* Chat / player opcodes, captured by driving the in-game StellaVision UI. */

// "Search" on the StellaVision menu, with "helpbot" typed in.
const FIND = '24 71 01 1e 68 65 6c 70 62 6f 74 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00';
// the reply; the u16 at +33 is Helpbot's sector (37)
const INFO = '36 71 01 1f 68 65 6c 70 62 6f 74 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 02 25 00 07 00 ef 24 00 00 00 00 00 00 01 00 01 00 00';
// sending "self delivery test" to blasto
const SEND = '36 71 01 19 62 6c 61 73 74 6f 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 73 65 6c 66 20 64 65 6c 69 76 65 72 79 20 74 65 73 74';
// the delivery that came back, sender name canonicalised to "Blasto"
const RECV = '42 71 01 1a 42 6c 61 73 74 6f 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01 01 00 01 00 00 00 00 00 00 00 00 73 65 6c 66 20 64 65 6c 69 76 65 72 79 20 74 65 73 74';

test('the new opcodes carry a consistent declared length', () => {
  for (const hex of [FIND, INFO, SEND, RECV]) {
    const b = bytes(hex);
    assert.equal(b[0], b.length, `len byte ${b[0]} != ${b.length}`);
    assert.equal(b[2], 0x01, 'SIP channel');
  }
});

test('0x19 decodes an outgoing message', () => {
  const m = P.splitFrames(bytes(SEND))[0];
  assert.equal(m.name, 'msg-send');
  assert.deepEqual(plain(P.decode(m.payload, m.type)), {
    kind: 'send', to: 'blasto', text: 'self delivery test'
  });
});

test('0x01 is the room login: it names the room we are in and us', () => {
  // captured verbatim as the client entered Central Fountain, the same second the
  // player feed put Blasto in sector 37
  const login = '50 71 01 01 10 00 0c 00 38 31 37 33 01 00 00 00 2d 49 00 00 07 42 6c 61 73 74 6f 00 25 00 31 32 30 33 64 64 34 36 61 30 30 30 30 30 30 30 30 65 66 63 64 31 37 39 31 63 33 39 63 30 39 63 64 37 35 37 61 65 36 39 37 38 39 61 66 63 66 36 37 00';
  const m = P.splitFrames(bytes(login))[0];
  assert.equal(m.name, 'login');
  assert.deepEqual(plain(P.decode(m.payload, m.type)), { kind: 'room', room: 37, name: 'Blasto' });

  // the room sits after a length-prefixed name, so a longer name moves it
  const longer = bytes('10 00 0c 00 38 31 37 33 01 00 00 00 2d 49 00 00 0b 54 69 6d 6d 79 32 45 4d 34 38 00 17 00 31 32 00');
  assert.deepEqual(plain(P.decode(longer, 0x01)), { kind: 'room', room: 23, name: 'Timmy2EM48' });
  assert.equal(P.decode(bytes('10 00 0c 00'), 0x01), null, 'a truncated frame is not a room');
});

test('0x1a decodes an incoming message past the 12-byte header', () => {
  const m = P.splitFrames(bytes(RECV))[0];
  assert.equal(m.name, 'msg-recv');
  assert.deepEqual(plain(P.decode(m.payload, m.type)), {
    kind: 'recv', from: 'Blasto', text: 'self delivery test'
  });
});

test('0x1f decodes a player search result including the sector', () => {
  const find = P.splitFrames(bytes(FIND))[0];
  assert.deepEqual(plain(P.decode(find.payload, find.type)), { kind: 'find', name: 'helpbot' });

  const info = P.splitFrames(bytes(INFO))[0];
  const d = plain(P.decode(info.payload, info.type));
  assert.equal(d.kind, 'info');
  assert.equal(d.name, 'helpbot');
  // /api/players independently reported Helpbot in sector 37
  assert.equal(d.sector, 37);
});

test('0x00 decodes room speech, which carries an explicit text length', () => {
  const m = P.splitFrames(bytes('18 71 01 00 20 4e 52 42 76 00 0d 00 ae 57 44 44 41 05 00 68 65 79 21 20'))[0];
  assert.equal(m.name, 'speech');
  assert.deepEqual(plain(P.decode(m.payload, 0x00)), { kind: 'speech', actor: 'NRBv', text: 'hey! ' });
});

test('0x00 reads a position update as a move, never as speech', () => {
  // same opcode, verb "TDPU": the next bytes are signed 16-bit coordinates, and
  // a coordinate pair read as a text length overruns the payload
  const m = P.splitFrames(bytes('1a 71 01 00 20 4e 52 42 78 00 0d 00 d4 54 44 50 55 7a 00 ef ff 80 ff 00 00 04'))[0];
  assert.deepEqual(plain(P.decode(m.payload, 0x00)), { kind: 'move', actor: 'NRBx' });
});

test('0x00 does not read any other verb as a move', () => {
  // "tnch" is another verb on the same opcode, and it is not a position update
  const m = P.splitFrames(bytes('1a 71 01 00 20 4e 52 42 78 00 0d 00 4b 74 6e 63 68 0a 00 00 00 00 00 00 00'))[0];
  assert.equal(P.decode(m.payload, 0x00), null);
});

test('0x00 rejects a NUL-padded field that is not text', () => {
  // verb "SYEK" has a plausible length but its bytes are not printable
  const m = P.splitFrames(bytes('1b 71 01 00 20 4e 52 42 78 00 0d 00 f5 53 59 45 4b 08 00 4e 54 42 43 00 00 00 00'))[0];
  assert.equal(P.decode(m.payload, 0x00), null);
});

test('0x00 keeps one-letter words, which is where the old scan lost them', () => {
  const m = P.splitFrames(bytes('16 71 01 00 20 4e 52 42 78 00 0d 00 84 57 44 44 41 02 00 61 20 00'))[0];
  assert.deepEqual(plain(P.decode(m.payload, 0x00)), { kind: 'speech', actor: 'NRBx', text: 'a ' });
});

test('0x17 decodes a sector range request, not a room move', () => {
  const m = P.splitFrames(bytes('0c 71 01 17 30 30 30 48 39 39 39 48'))[0];
  assert.equal(m.name, 'sector-range');
  // "000H999H" asks for the whole map and is answered by a 0x14 sector list
  assert.deepEqual(plain(P.decode(m.payload, m.type)), { kind: 'sector-range', from: '000H', to: '999H' });
});

test('buildMessage reproduces the captured send frame byte for byte', () => {
  const built = P.buildMessage('blasto', 'self delivery test');
  assert.ok(built, 'encoder returned null');
  assert.deepEqual([...built], [...bytes(SEND)]);
});

test('buildMessage pads the recipient and enforces limits', () => {
  const b = P.buildMessage('ab', 'hi');
  assert.equal(b.length, 4 + 32 + 2);
  assert.equal(b[0], b.length, 'length prefix must match');
  assert.equal(b[2], 0x01);
  assert.equal(b[3], 0x19);
  // recipient is NUL padded out to 32 bytes
  assert.equal(P.fstr(b, 4, 32), 'ab');
  assert.equal(P.text(b, 36), 'hi');

  assert.equal(P.buildMessage('', 'hi'), null, 'recipient required');
  assert.equal(P.buildMessage('ab', ''), null, 'body required');
  assert.equal(P.buildMessage('a'.repeat(40), 'hi'), null, 'recipient is rejected rather than truncated');
  assert.equal(P.buildMessage('ab', 'x'.repeat(181)), null, 'body is rejected rather than truncated');
  // a body that would overflow the one-byte length prefix is rejected
  assert.equal(P.buildMessage('ab', 'x'.repeat(400), 400), null);
  assert.equal(P.buildMessage('ab', 'x'.repeat(180)).length, 4 + 32 + 180, 'body at the maximum fits');
});

test('message encoding accepts printable ASCII and rejects Unicode without corruption', () => {
  assert.equal(P.printableAscii('Hello, world!'), true);
  assert.equal(P.printableAscii(''), true);
  assert.equal(P.printableAscii('caf\u00e9'), false);
  assert.equal(P.printableAscii('emoji \u{1f600}'), false);
  assert.equal(P.buildMessage('Blasto', 'caf\u00e9'), null);
  assert.equal(P.buildMessage('Blasto', 'emoji \u{1f600}'), null);
  assert.equal(P.buildMessage('Blasto\u00e9', 'hello'), null, 'recipient is validated too');
});

test('decode returns null for opcodes we have not pinned down', () => {
  assert.equal(P.decode(new Uint8Array([1, 2, 3]), 0x0b), null);
  assert.equal(P.decode(new Uint8Array(0), 0x99), null);
});

test('redact removes the account key in both raw and hex form', () => {
  const key = 'HYPCDCJGBSYKGE2';
  const hexed = [...key].map((c) => c.charCodeAt(0).toString(16)).join(' ');
  assert.equal(P.redact(`name=${key}`, key), 'name=[key]');
  assert.equal(P.redact(`raw ${hexed} raw`, key), 'raw [key] raw');
  assert.equal(P.redact('nothing secret', key), 'nothing secret');
  assert.equal(P.redact(null, key), null);
  assert.equal(P.redact('abc', ''), 'abc');
});

test('hex formats two-digit lowercase bytes', () => {
  assert.equal(P.hex(new Uint8Array([0x0a, 0xff, 0x00])), '0a ff 00');
  assert.equal(P.hex(new Uint8Array([1, 2, 3]), 2), '01 02 …');
});

test('0x14 yields the actor name record, which is how a speaker gets a name', () => {
  // real capture: id 124 is Blasto, and his speech tag is "NRB" + chr(124) = "NRB|"
  const payload = bytes('02 00 00 00 6f 00 98 fe 01 84 08 a5 07 00 8e 84 1e 00 7c 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 06 00 42 6c 61 73 74 6f');
  // this record ends at the name, so the parts window is the four bytes before its
  // end: nothing follows it, which is exactly the "named but faceless" shape.
  assert.deepEqual(plain(P.decode(payload, 0x14)),
    { kind: 'actors', list: [{ id: 124, name: 'Blasto', key: 2000014, probe: '61 73 74 6f' }] });
  assert.equal('NRB' + String.fromCharCode(124), 'NRB|');
});

test('0x02 yields the actor name record, which is how a late joiner is named', () => {
  // a real 0x02 frame captured on entering a room: the server sends one as each
  // actor appears, so an actor who joins after us is only ever named here.
  const payload = bytes('02 00 00 00 6f 00 98 fe 01 84 08 a5 07 00 8e 84 1e 00 7c 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 06 00 42 6c 61 73 74 6f 0b 00 00 00 1e 00 1c 00 16 00 01 03 00 00 00 00 00 00 00 00 00 00 00 00 0b 00 00 00 ec 30 4c 46 01 03 00 00 00 00 00 00 92 ba 12 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff 0b 00 00 00 ed 30 4c 46 00 02 00 00 16 00 fc ff 92 de 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff');
  // head 30 is h30coin, which is what this player wore in that session — they had
  // moved to the goldfish bowl (4) by the time the offset was confirmed.
  assert.deepEqual(plain(P.decode(payload, 0x02)), {
    kind: 'actors',
    list: [{ id: 124, name: 'Blasto', key: 2000014, head: 30, body: 28, feet: 22 }]
  });
});

test('an actor record with a non-name value is ignored', () => {
  const payload = bytes('02 00 00 00 6f 00 98 fe 01 84 08 a5 07 00 8e 84 1e 00 7c 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 06 00 42 6c 61 73 74 00');
  assert.equal(P.decode(payload, 0x14), null, 'a NUL in the value is not a name');
});

test('0x04 carries an actor name record, sent as somebody new appears', () => {
  // captured verbatim when another player walked in: "_actorName" -> "Timmy2BYX6"
  // for id 119, which is the actor tag NRBw ('w' = 119)
  const hex = '02 00 00 00 6f 00 98 fe 01 84 08 a5 07 00 89 84 1e 00 77 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 0a 00 54 69 6d 6d 79 32 42 59 58 36 06 00 00 00 01 00 01 00 02 00 01 03 00 00 00 00 00 00 00 00 00 00 06 00 00 00 e2 30 4c 46 01 03 00 00 00 00 00 00 92 ba 12 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff 06 00 00 00 e3 30 4c 46 00 02 00 00 16 00 fc ff 92 de 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff';
  assert.deepEqual(plain(P.decode(bytes(hex), 0x04)),
    { kind: 'actors', list: [{ id: 119, name: 'Timmy2BYX6', key: 2000009, head: 1, body: 1, feet: 2 }], live: true });
});

test('an actor record carries the schtick parts, so a name comes with a head', () => {
  // Three real records, each from a player whose head is known by eye. The three
  // u16s straight after the name are head, body and feet, and every one of them
  // is a directory that exists under /release/art/schtick.
  const cases = [
    // the goldfish bowl (h04fishbowl), captured on entering Central Fountain
    ['02', '9e 71 01 02 02 00 00 00 6f 00 98 fe 01 84 08 a5 07 00 88 84 1e 00 76 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 06 00 42 6c 61 73 74 6f 05 00 00 00 04 00 1c 00 16 00 01 03 00 00 00 00 00 00 00 00 00 00 05 00 00 00 e0 30 4c 46 01 03 00 00 00 00 00 00 92 ba 12 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff 05 00 00 00 e1 30 4c 46 00 02 00 00 16 00 fc ff 92 de 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff',
      'Blasto', 4, 28, 22],
    // the robot (h12robot)
    ['09', '98 71 01 09 00 01 84 08 a5 07 00 88 84 1e 00 76 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 07 00 48 65 6c 70 62 6f 74 05 00 00 00 0c 00 35 00 1d 00 01 03 00 00 30 00 ef ff 00 00 00 00 05 00 00 00 e0 30 4c 46 01 03 00 00 00 00 00 00 92 ba 12 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff 05 00 00 00 e1 30 4c 46 00 02 00 00 c8 0f 81 04 92 de 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff',
      'Helpbot', 12, 53, 29],
    // a fresh account, still in the starting schtick: head 1, body 1, feet 2
    ['04', 'a2 71 01 04 02 00 00 00 6f 00 98 fe 01 84 08 a5 07 00 89 84 1e 00 77 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 0a 00 54 69 6d 6d 79 32 45 4d 34 38 06 00 00 00 01 00 01 00 02 00 01 03 00 00 00 00 00 00 00 00 00 00 06 00 00 00 e2 30 4c 46 01 03 00 00 00 00 00 00 92 ba 12 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff 06 00 00 00 e3 30 4c 46 00 02 00 00 16 00 fc ff 92 de 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff',
      'Timmy2EM48', 1, 1, 2]
  ];
  for (const [op, hex, name, head, body, feet] of cases) {
    const b = bytes(hex);
    const d = plain(P.decode(b.subarray(4), parseInt(op, 16))).list[0];
    assert.equal(d.name, name);
    assert.equal(d.head, head, `${name} head`);
    assert.equal(d.body, body, `${name} body`);
    assert.equal(d.feet, feet, `${name} feet`);
  }
});

test("a parts marker whose second byte is not 03 still reads", () => {
  // Measured on a live session: this player's record carries head 24 and a marker of
  // `01 07`, while every other record seen has `01 03`. Requiring the 03 exactly is
  // what reported him faceless while his parts were right there in the payload.
  const hex = '98 71 01 09 00 01 84 08 a5 07 00 88 84 1e 00 76 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 07 00 48 65 6c 70 62 6f 74 05 00 00 00 0c 00 35 00 1d 00 01 07 00 00 30 00 ef ff 00 00 00 00 05 00 00 00 e0 30 4c 46 01 03 00 00';
  const d = plain(P.decode(bytes(hex).subarray(4), 0x09)).list[0];
  assert.equal(d.name, 'Helpbot');
  assert.equal(d.head, 12, 'the head is read whatever the marker byte says');
  assert.equal(d.body, 53);
  assert.equal(d.feet, 29);
  assert.equal(d.probe, undefined, 'a record that read cleanly needs no probe');
});

test('parts that do not read as parts are left out, not guessed at', () => {
  // the same record with the parts record's marker broken: no head is better than
  // somebody else's head
  const base = '02 00 00 00 6f 00 98 fe 01 84 08 a5 07 00 88 84 1e 00 76 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 06 00 42 6c 61 73 74 6f 05 00 00 00 04 00 1c 00 16 00 MARK 00 00 00 00 00 00 00 00 00 00';
  const noMarker = plain(P.decode(bytes(base.replace('MARK', '09 04')), 0x02)).list[0];
  assert.equal(noMarker.head, undefined);

  const outOfRange = plain(P.decode(bytes(base.replace('MARK', '01 03').replace('04 00 1c 00 16 00', 'ff 00 1c 00 16 00')), 0x02)).list[0];
  assert.equal(outOfRange.head, undefined, '255 is not a head');

  const truncated = plain(P.decode(bytes('02 00 00 00 6f 00 98 fe 01 84 08 a5 07 00 88 84 1e 00 76 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 06 00 42 6c 61 73 74 6f 05 00'), 0x02)).list[0];
  assert.equal(truncated.head, undefined, 'the record ends before the parts do');
});

test('a head without a torso is still a head', () => {
  // Each part is independent: 0 means "none", not "misread". A record can carry a
  // head and nothing else, and dropping it was throwing away a face that the wire
  // had named.
  const base = '02 00 00 00 6f 00 98 fe 01 84 08 a5 07 00 88 84 1e 00 76 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 06 00 42 6c 61 73 74 6f 05 00 00 00 0c 00 00 00 00 00 01 03 00 00 00 00 00 00 00 00 00 00';
  const d = plain(P.decode(bytes(base), 0x02)).list[0];
  assert.equal(d.name, 'Blasto');
  assert.equal(d.head, 12, 'the head survives an empty torso and legs');
  assert.equal(d.body, undefined);
  assert.equal(d.feet, undefined);
});

test('the actor key is the id plus a fixed base, so a bare key still names somebody', () => {
  // every actor record carries a 32-bit key in front of the id, and every capture
  // so far agrees on the base: 0x1e8412. The departure record quotes only the key,
  // so this is what turns it back into a tag.
  const rec = (keyHex, id) => bytes(`02 00 00 00 6f 00 98 fe 01 84 08 a5 07 00 ${keyHex} ${id} 00 0d 00 01 00 00 00 01 00 01 01 0a 00 5f 61 63 74 6f 72 4e 61 6d 65 ff ff 05 00 00 00 06 00 42 6c 61 73 74 6f 00`);
  // captured from three different sessions: Blasto id 124, Blasto id 119, Helpbot id 118
  [[0x1e848e, 124], [0x1e8489, 119], [0x1e8488, 118]].forEach(([key, id]) => {
    const a = plain(P.decode(rec(
      key.toString(16).padStart(8, '0').match(/../g).reverse().join(' '),
      id.toString(16).padStart(2, '0')), 0x02)).list[0];
    assert.equal(a.id, id);
    assert.equal(a.key, key);
    assert.equal(a.key - a.id, 0x1e8412, 'the base is constant');
  });
});

test('0x05 says an actor left, and carries nothing but their key', () => {
  // captured verbatim as another player walked out: their name record said id 119
  // ("NRBw"), and this is the very next thing the room said about them.
  const payload = bytes('89 84 1e 00');
  assert.deepEqual(plain(P.decode(payload, 0x05)), { kind: 'left', key: 0x1e8489 });
  assert.equal(P.decode(bytes('89 84'), 0x05), null, 'a short payload is not a departure');
  assert.equal(P.TYPES[0x05], 'leave');
});
