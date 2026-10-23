/* C8 Chat - wire protocol codec.
 *
 * Runs in the MAIN world alongside src/agent.js and hangs off window.C8Proto.
 *
 * Wire format (reverse-engineered from live captures):
 *
 *   [ len:u8 ][ 0x71 ][ channel:u8 ][ opcode:u8 ][ payload: len-4 bytes ]
 *
 * channel 0x01 is the in-game sector server (SIP), 0x08 is the metaserver (ILP).
 * Several messages are concatenated inside a single WebSocket frame, and a
 * message can never exceed 255 bytes, so large payloads (the sector list) are
 * chunked by the server.
 */
(function (global) {
  'use strict';

  var MAGIC = 0x71;

  var CHANNELS = { 0x01: 'sip', 0x08: 'ilp' };

  var TYPES = {
    0x00: 'speech',
    0x01: 'login',
    0x02: 'actor-join',
    0x03: 'server-assign',
    0x04: 'greet',
    0x05: 'leave',
    0x06: 'sync',
    0x0b: 'keepalive',
    0x14: 'sector-list',
    0x16: 'sector-query',
    0x17: 'sector-range',
    0x18: 'ping',
    0x19: 'msg-send',
    0x1a: 'msg-recv',
    0x1e: 'find-player',
    0x1f: 'player-info',
    0x28: 'op28'
  };

  // Sender/recipient fields are 32 bytes wide; the receive header carries 12
  // bytes of metadata between the name and the message body.
  var NAME_FIELD = 32;
  var RECV_HEADER = NAME_FIELD + 12;

  /** Split one WebSocket payload into protocol messages. */
  function splitFrames(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var out = [];
    var i = 0;
    while (i + 4 <= u8.length) {
      var len = u8[i];
      if (len < 4 || u8[i + 1] !== MAGIC || i + len > u8.length) {
        // Not a message boundary we understand: keep the remainder verbatim so
        // the capture view can still show it.
        out.push({ channel: -1, type: -1, name: 'raw', payload: u8.subarray(i), bad: true });
        break;
      }
      var ch = u8[i + 2];
      var type = u8[i + 3];
      out.push({
        channel: ch,
        channelName: CHANNELS[ch] || 'ch' + ch,
        type: type,
        name: TYPES[type] || 'type-' + type.toString(16),
        payload: u8.subarray(i + 4, i + len)
      });
      i += len;
    }
    return out;
  }

  /** Fixed-width, NUL-padded string (16 bytes for the login name/key). */
  function fstr(u8, off, n) {
    if (off + n > u8.length) return '';
    var end = off;
    while (end < off + n && u8[end] !== 0) end++;
    return ascii(u8, off, end - off);
  }

  function ascii(u8, off, n) {
    var s = '';
    for (var i = 0; i < n; i++) {
      var b = u8[off + i];
      s += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
    }
    return s;
  }

  /**
   * Printable runs of >= `min` characters. This is the workhorse of the
   * capture view: every protocol finding so far came out of this.
   */
  function printable(payload, min) {
    min = min || 4;
    var runs = [];
    var cur = '';
    for (var i = 0; i < payload.length; i++) {
      var b = payload[i];
      if (b >= 32 && b < 127) {
        cur += String.fromCharCode(b);
      } else {
        if (cur.length >= min) runs.push(cur);
        cur = '';
      }
    }
    if (cur.length >= min) runs.push(cur);
    return runs;
  }

  /** type 0x14: repeated { 4-char sector code, u32 value }. */
  function sectorEntries(payload) {
    var out = [];
    for (var i = 0; i + 8 <= payload.length; i += 8) {
      var code = ascii(payload, i, 4);
      if (!/^[0-9A-Za-z ]{4}$/.test(code)) continue;
      var v = payload[i + 4] | (payload[i + 5] << 8) | (payload[i + 6] << 16) | (payload[i + 7] << 24);
      out.push({ code: code, value: v >>> 0 });
    }
    return out;
  }

  /**
   * Remove an account key from text about to be forwarded or stored. Handles
   * both the raw key and its space-separated hex form, because captures are
   * rendered as hex.
   */
  function redact(text, secret) {
    if (typeof text !== 'string' || !text || !secret) return text;
    var out = text.split(secret).join('[key]');
    var hx = '';
    for (var i = 0; i < secret.length; i++) hx += (i ? ' ' : '') + secret.charCodeAt(i).toString(16);
    return out.split(hx).join('[key]');
  }

  /**
   * Decode a message body into a plain object, or null if we have no decoder.
   *
   * The chat opcodes were pinned down by driving the in-game StellaVision UI and
   * diffing the frames either side of the action:
   *   0x19 out  [to: 32B][text...]                 sending a message
   *   0x1a in   [from: 32B][12B meta][text...]     receiving one
   *   0x1e out  [name: 32B]                        "Search" in StellaVision
   *   0x1f in   [name: 32B][18B info]              the search result
   *   0x17 out  [from: 4B][to: 4B]                 room transfer
   */
  function decode(payload, type) {
    try {
      switch (type) {
        case 0x01: {
          // The login the client sends every time it connects to a room's server, so
          // this is the one place on the wire that says which room we are in:
          //
          //   10 00 | 0c 00 | "8173" | 01 00 00 00 | 2d 49 00 00 | 07 "Blasto" 00 | 25 00 | <key>
          //                                                          ^name pstr     ^room 0x25 = 37
          //
          // Measured against the player feed in the same second (37, Central
          // Fountain) and against the fountain the room's chat was talking about.
          // The room number is the first column of connect.dat, which is where the
          // room names come from. The 4-character field is not a room code: "8173"
          // appears nowhere in connect.dat.
          if (payload.length < 27) return null;
          var n = payload[16];                       // pstr length, NUL included
          var at = 17 + n;
          // A name is short and the room follows it, so the bound keeps some other
          // payload that merely happens to be 0x01 from being read as a room.
          if (n < 1 || n > 32 || at + 2 > payload.length) return null;
          var room = payload[at] | (payload[at + 1] << 8);
          if (!room) return null;
          return { kind: 'room', room: room, name: fstr(payload, 17, n - 1) };
        }
        case 0x19:
          return { kind: 'send', to: fstr(payload, 0, NAME_FIELD), text: text(payload, NAME_FIELD) };
        case 0x1a:
          return { kind: 'recv', from: fstr(payload, 0, NAME_FIELD), text: text(payload, RECV_HEADER) };
        case 0x1e:
          return { kind: 'find', name: fstr(payload, 0, NAME_FIELD) };
        case 0x1f:
          return {
            kind: 'info',
            name: fstr(payload, 0, NAME_FIELD),
            // u16 sector sits at +33, immediately after the name and a 1-byte tag
            sector: payload.length >= 35 ? (payload[33] | (payload[34] << 8)) : null
          };
        case 0x17:
          // Not a room move: a request for a range of sectors, immediately
          // followed by a 0x14 sector list. "000H999H" means the whole map.
          return { kind: 'sector-range', from: ascii(payload, 0, 4), to: ascii(payload, 4, 4) };
        case 0x00:
          return speech(payload) || position(payload);
        case 0x04: {
          // Somebody appeared. Same record shape as the roster below, but it is
          // live news rather than a baseline, so it is marked as such — the panel
          // must not treat an actor it just named as one it has already seen, or
          // their arrival is never announced.
          var live = actorNames(payload);
          return live.length ? { kind: 'actors', list: live, live: true } : null;
        }
        case 0x05: {
          // Somebody left the room. The payload is nothing but their actor key —
          // the 32-bit value that sits in front of the id in an actor record — so
          // this is the exact counterpart of 0x04, and it lands the moment they go
          // rather than whenever the player feed next updates.
          if (payload.length < 4) return null;
          return { kind: 'left', key: u32(payload, 0) };
        }
        case 0x02:   // our own descriptor, sent once as we arrive
        case 0x09:
        case 0x14: {
          var actors = actorNames(payload);
          return actors.length ? { kind: 'actors', list: actors } : null;
        }
        default:
          return null;
      }
    } catch (e) {
      return null;
    }
  }

  /**
   * Actor name records, carried by opcode 0x02 (an actor entering the room — the
   * only way a late joiner is ever named), by 0x09 (a room's occupants) and by the
   * 0x14 sector list (at least ourselves):
   *
   *   7c 00 | 0d 00 | 01 00 00 00 | 01 00 01 01 | 0a 00 | "_actorName" | ff ff | 05 00 00 00 | 06 00 | "Blasto"
   *    id                                        keylen                   padding               len    name
   *
   * This is the only place a player name appears. Speech carries no name, only
   * an actor tag of "NRB" + chr(id), so the id here is what names a speaker.
   */
  var ACTOR_KEY = [0x5f, 0x61, 0x63, 0x74, 0x6f, 0x72, 0x4e, 0x61, 0x6d, 0x65]; // "_actorName"

  /** Little-endian u32, the width the protocol gives an actor key. */
  function u32(payload, off) {
    return (payload[off] | (payload[off + 1] << 8) |
            (payload[off + 2] << 16) | (payload[off + 3] << 24)) >>> 0;
  }

  /**
   * Opcode 0x00 also carries actor position updates. They share the speech header
   * and put coordinates where speech puts a length and text, which is why speech()
   * rejects them:
   *
   *   20 4e524275 00 0d00 38 54445055 2b00efff8000000008
   *   ^  actor    ^  ^    ^  "TDPU"  ^ x, y, z
   *   0x20        NUL 0x0d00 counter
   *
   * An actor can only move if they are in the room, so this is the cheapest proof
   * that a given player is present — it arrives the instant they do anything.
   */
  var MOVE_VERB = [0x54, 0x44, 0x50, 0x55]; // "TDPU"

  function position(payload) {
    if (payload.length < 13) return null;
    if (payload[0] !== 0x20 || payload[5] !== 0x00) return null;
    if (payload[6] !== 0x0d || payload[7] !== 0x00) return null;
    for (var k = 0; k < MOVE_VERB.length; k++) {
      if (payload[9 + k] !== MOVE_VERB[k]) return null;
    }
    return { kind: 'move', actor: ascii(payload, 1, 4) };
  }

  function actorNames(payload) {
    var out = [];
    for (var i = 14; i + 18 <= payload.length; i++) {
      var hit = true;
      for (var k = 0; k < ACTOR_KEY.length; k++) {
        if (payload[i + k] !== ACTOR_KEY[k]) { hit = false; break; }
      }
      if (!hit) continue;
      if (payload[i - 2] !== ACTOR_KEY.length || payload[i - 1] !== 0x00) continue;

      // the id sits 14 bytes back, and the marker that it is one is the 0x0d00
      // field immediately after it
      var idOff = i - 14;
      if (payload[idOff + 2] !== 0x0d || payload[idOff + 3] !== 0x00) continue;
      var id = payload[idOff] | (payload[idOff + 1] << 8);
      if (id < 1 || id > 255) continue;          // the tag encodes it in one byte

      // The actor's 32-bit key sits immediately in front of the id. It is what
      // opcode 0x05 quotes back when they leave, and measured across five captures
      // (three sessions) it is always 1999890 + id — so it names a departure even
      // for an actor we never got a name record for.
      var key = idOff >= 4 ? u32(payload, idOff - 4) : null;

      var lOff = i + ACTOR_KEY.length + 6;       // padding + count, then the length
      var n = payload[lOff] | (payload[lOff + 1] << 8);
      if (n < 1 || lOff + 2 + n > payload.length) continue;

      var name = '';
      var clean = true;
      for (var j = 0; j < n; j++) {
        var c = payload[lOff + 2 + j];
        if (c < 32 || c > 126) { clean = false; break; }
        name += String.fromCharCode(c);
      }
      if (clean) {
        var parts = schtickParts(payload, lOff + 2 + n);
        out.push({ id: id, name: name, key: key, head: parts.head, body: parts.body, feet: parts.feet });
      }
    }
    return out;
  }

  /**
   * The three schtick part ids that sit immediately after an _actorName value:
   *
   *   ... 06 00 "Blasto" | 05 00 00 00 | 04 00 1c 00 16 00 | 01 03 00 00 ...
   *                        ^             head  body  feet    ^ the parts record
   *   head 4 is h04fishbowl, body 28 t28airplane, feet 22 l22gooey.
   *
   * Read against players whose heads are known — a goldfish bowl and a robot —
   * and every id parsed out of every capture is a directory that exists under
   * /release/art/schtick, which is what says the offset is right. The ids are
   * carried on all four actor records (0x02, 0x04, 0x09, 0x14), so a head is
   * known as soon as a name is.
   */
  var MAX_PART = 54;                             // kMaxSchtickID

  function schtickParts(payload, off) {
    if (off + 14 > payload.length) return {};
    // the parts record's own marker: 01 03, then the padding that follows it
    if (payload[off + 10] !== 0x01 || payload[off + 11] !== 0x03) return {};
    if (payload[off + 12] !== 0x00 || payload[off + 13] !== 0x00) return {};
    var head = payload[off + 4] | (payload[off + 5] << 8);
    var body = payload[off + 6] | (payload[off + 7] << 8);
    var feet = payload[off + 8] | (payload[off + 9] << 8);
    // Each part stands on its own. Requiring all three to be in range threw away a
    // head the moment a torso was missing, and 0 for a part means "none" rather
    // than "misread" — a body-less actor is exactly what a head-only NPC record
    // looks like. A value outside the range is still a misread, and no icon reads
    // better than somebody else's head.
    var out = {};
    if (part(head)) out.head = head;
    if (part(body)) out.body = body;
    if (part(feet)) out.feet = feet;
    return out;
  }

  function part(v) { return v >= 1 && v <= MAX_PART; }

  /**
   * Opcode 0 carries the room speech balloon, streamed one word per frame:
   *
   *   20 4e524278 00 0d00 1a 57444441 0400 68657920 00
   *   ^  actor    ^  ^    ^  verb     ^    "hey "   ^
   *   |  "NRBx"   |  |    |  "WDDA"   u16 length   NUL
   *   0x20        NUL 0x0d00 counter
   *
   * The same opcode also carries actor position updates, whose verb is "TDPU"
   * and whose following bytes are signed 16-bit coordinates. Those are rejected
   * by the length check: a coordinate pair read as a text length overruns the
   * payload, whereas a real word always fits exactly.
   *
   * The actor tag is opaque — no player name is ever sent with the speech, so it
   * is the only way to tell speakers apart.
   */
  function speech(payload) {
    if (payload.length < 15) return null;
    if (payload[0] !== 0x20 || payload[5] !== 0x00) return null;
    if (payload[6] !== 0x0d || payload[7] !== 0x00) return null;
    var n = payload[13] | (payload[14] << 8);
    if (n < 1 || payload.length < 15 + n) return null;
    // Test the raw bytes, not ascii()'s rendering of them: ascii() masks
    // everything unprintable as '.', which would let any binary field through.
    for (var i = 0; i < n; i++) {
      var c = payload[15 + i];
      if (c < 32 || c > 126) return null;
    }
    return { kind: 'speech', actor: ascii(payload, 1, 4), text: ascii(payload, 15, n) };
  }

  /** Decode from `off` to the end, dropping NUL padding and control bytes. */
  function text(u8, off) {
    if (off >= u8.length) return '';
    var end = u8.length;
    while (end > off && (u8[end - 1] === 0 || u8[end - 1] === 32)) end--;
    var out = '';
    for (var i = off; i < end; i++) {
      var b = u8[i];
      out += b >= 32 && b < 127 ? String.fromCharCode(b) : (b === 0 ? '' : '.');
    }
    return out;
  }

  /**
   * Encode a message-send frame (0x19): [len][0x71][0x01][0x19][to: 32B][text].
   *
   * This is byte-for-byte what the client itself emits from the StellaVision
   * compose screen, so the server parses it identically. Lengths are enforced
   * here because the client would otherwise do it.
   */
  /** The game chat packet and key-input API carry printable 7-bit ASCII only. */
  function printableAscii(value) {
    return typeof value === 'string' && /^[\x20-\x7e]*$/.test(value);
  }

  function buildMessage(to, body, maxText) {
    to = String(to == null ? '' : to);
    body = String(body == null ? '' : body);
    maxText = maxText == null ? 180 : Number(maxText);
    if (!to || !body || !isFinite(maxText) || maxText < 0) return null;
    if (!printableAscii(to) || !printableAscii(body)) return null;
    // Do not silently truncate a recipient or body: callers can report the exact
    // limit and preserve the user's draft rather than sending altered content.
    if (to.length > NAME_FIELD - 1 || body.length > maxText) return null;
    var len = 4 + NAME_FIELD + body.length;
    if (len > 255) return null;
    var out = new Uint8Array(len);
    out[0] = len;
    out[1] = MAGIC;
    out[2] = 0x01; // SIP
    out[3] = 0x19; // message send
    var i;
    for (i = 0; i < to.length; i++) out[4 + i] = to.charCodeAt(i) & 0x7f;
    for (i = 0; i < body.length; i++) out[4 + NAME_FIELD + i] = body.charCodeAt(i) & 0x7f;
    return out;
  }

  function hex(u8, max) {
    var n = Math.min(u8.length, max || 512);
    var s = '';
    for (var i = 0; i < n; i++) s += (i ? ' ' : '') + (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return s + (u8.length > n ? ' …' : '');
  }

  global.C8Proto = {
    MAGIC: MAGIC,
    CHANNELS: CHANNELS,
    TYPES: TYPES,
    NAME_FIELD: NAME_FIELD,
    RECV_HEADER: RECV_HEADER,
    splitFrames: splitFrames,
    fstr: fstr,
    ascii: ascii,
    text: text,
    decode: decode,
    buildMessage: buildMessage,
    printableAscii: printableAscii,
    printable: printable,
    sectorEntries: sectorEntries,
    redact: redact,
    hex: hex
  };
})(typeof window !== 'undefined' ? window : globalThis);
