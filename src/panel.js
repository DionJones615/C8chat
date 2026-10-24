/* C8 Chat - isolated-world panel.
 *
 * Owns all DOM, storage and feature logic. Talks to src/agent.js over
 * window.postMessage; never touches page globals itself.
 */
(function () {
  'use strict';

  var CH = '__c8_chat__';
  var PANEL_CSS = '';

  /* ------------------------------------------------------------------ state */

  var S = {
    settings: {
      panel: null,           // {x, y, w, h} once the user moves or resizes it
      /* Where the panel sits. Floating is the box above; docked is a full-height
         column against one side of the viewport, with the game given the rest.
         dockW is the docked width and is kept apart from `panel` so switching to
         float restores the position and size the user chose there. */
      dock: 'float',         // 'float', 'left' or 'right'
      dockW: 360,            // used only while docked
      /* Chat log presentation. Flat keys, because `load` merges the stored object
         over these with a shallow Object.assign: a nested object would be replaced
         whole by any build that knew fewer keys, and every one of them would come
         back undefined. Defaults are exactly the look the panel had before any of
         this was settable, so a stored scrollback renders the same either way. */
      theme: 'bighead',      // the Default theme (labelled so in the picker)
      chatSize: 12,
      tsFormat: 'locale',
      headPct: 0,            // 0 = whatever the theme asks for; else percent of the art's native size
      showHeads: true,
      showNicks: true,
      nickColors: true,
      showSys: true,
      showPresence: true
    },
    irc: [],
    pmRecent: [],
    capture: [],
    captureOn: false
  };

  /* The chat log's look, as choices rather than free text: every one of these ends
     up in a class or a custom property, so an unrecognised stored value is simply
     normalised back to the default instead of producing a log with no styling. */
  // Big heads leads the list: pick() normalises anything unknown (including no
  // stored choice at all) to the first entry, so leading with it makes it the
  // default theme. Its id stays 'bighead' so a stored preference from the builds
  // that called it Big heads keeps working; only the label changed.
  var THEMES = [['bighead', 'Default'], ['classic', 'Classic'], ['paper', 'Paper (light)'], ['amber', 'Terminal (amber)']];
  // Floating leads, so pick() normalises an unknown stored value back to it.
  var PLACEMENTS = [['float', 'Floating'], ['left', 'Dock left'], ['right', 'Dock right']];
  var SIZES = [11, 12, 13, 14, 15, 16, 18];
  var TS_FMT = [['locale', 'Default'], ['hm', '24-hour'], ['hms', '24-hour + seconds'], ['h12', '12-hour'], ['off', 'Hidden']];
  var HEAD_PCT = [[0, 'Theme default'], [50, '50%'], [100, '100%'], [150, '150%'], [200, '200%']];
  /* `locale` is what the panel has always shown — the browser's own 12- or 24-hour
     reading — so it stays the default and nobody's log changes under them. The rest
     pin it, which is the point of the setting. */
  var TS_OPTS = {
    locale: { hour: '2-digit', minute: '2-digit' },
    hm: { hour: '2-digit', minute: '2-digit', hour12: false },
    hms: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
    h12: { hour: 'numeric', minute: '2-digit', hour12: true }
  };

  function pick(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i][0] === value) return value;
    return list[0][0];
  }

  /** The nearest size the setting can actually show, so the panel and its control agree. */
  function clampSize(n) {
    n = parseInt(n, 10) || 12;
    var best = SIZES[0];
    SIZES.forEach(function (s) { if (Math.abs(s - n) < Math.abs(best - n)) best = s; });
    return best;
  }

  /** The time a line shows, or '' when the reader has turned the stamp off. */
  function fmtTime(ms, spec) {
    spec = TS_OPTS[spec || S.settings.tsFormat];
    return spec ? new Date(ms).toLocaleTimeString([], spec) : '';
  }

  var agent = { hasFs: false, state: null, user: null };
  var players = { online: [], err: null, at: 0 };   // at: when it was last read
  var rooms = {};
  // The room type is in connect.dat, not on the wire. A TEAM room is one that a
  // TEAM record reaches and no ordinary record does — its only entrance is a TEAM
  // entrance. The live file drops the destination for non-numeric TEAM tags and has
  // no rows for 54/56; the older data confirms those five are TEAM-only, so they are
  // kept as a small fallback rather than guessed at runtime.
  var teamRow = {};
  var teamIn = {};
  var normalIn = {};
  var TEAM_FALLBACK = { 25: 1, 52: 1, 53: 1, 54: 1, 56: 1 };
  var teamAck = null;
  var roomsLoading = false;
  var headsLoading = false;
  var pending = new Map();
  var seq = 0;
  var host, root;
  var sending = false;

  /**
   * The scrollback as plain data. Entries carry `_msg`, the live DOM node a line
   * is grown through, and structured clone refuses to store a node — so the whole
   * set rejected and every save failed silently. The log then appeared frozen at
   * whatever was last stored by a build that predated the field.
   */
  function storable() {
    return S.irc.slice(-MAX_LINES).map(function (e) {
      var copy = {};
      Object.keys(e).forEach(function (k) {
        if (k.charAt(0) !== '_') copy[k] = e[k];
      });
      return copy;
    });
  }

  /**
   * How many lines the transcript keeps. It is a ring: past this, the oldest lines
   * rotate out as new ones arrive, so a session's log never grows without bound.
   */
  var MAX_LINES = 300;

  // 2000-01-01, in ms. Nothing this panel writes is older.
  var WALL_CLOCK = 946684800000;

  /**
   * Whether a stored line is one this build could have written.
   *
   * The store is shared with every build that has ever run on this profile, and an
   * older one wrote a different kind of line: raw frames ("type-0: …"), speech with no
   * speaker, so it rendered "<undefined>", and a `t` holding uptime rather than a clock
   * — which is why those lines all read 12:00 AM. Adopting them put a foreign
   * transcript in front of this session's, and then re-saved it, so it came back every
   * single restart. A wall-clock stamp is what tells our lines from theirs.
   */
  function ours(e) {
    return !!e && typeof e.text === 'string' && e.text &&
      typeof e.kind === 'string' && typeof e.t === 'number' && e.t > WALL_CLOCK;
  }

  var saveState = { ok: 0, err: null, at: 0, bytes: 0, lines: 0 };

  function save() {
    // A page that was reloaded or updated can still have the previous panel's script
    // alive; one of those must never write over the log the visible panel owns.
    if (!current()) return;
    try {
      var payload = {
        irc: storable(),
        pmRecent: S.pmRecent,
        // A face learned once is worn again next time, even by a record that arrives
        // without schtick parts. Bounded: the map is a convenience, not a directory.
        knownHeads: cappedHeads(),
        lastRoom: mySector,
        settings: S.settings
      };
      saveState.lines = payload.irc.length;
      try { saveState.bytes = JSON.stringify(payload).length; } catch (e) { saveState.bytes = -1; }
      var writing = chrome.storage.local.set(payload);
      if (writing && typeof writing.then === 'function') {
        writing.then(function () { saveState.ok++; saveState.at = Date.now(); saveState.err = null; },
                     function (e) { saveState.err = String(e && e.message || e); });
      } else {
        saveState.ok++; saveState.at = Date.now(); saveState.err = null;
      }
    } catch (e) {
      saveState.err = String(e && e.message || e);
    }
  }

  function load() {
    try {
      chrome.storage.local.get(['settings', 'irc', 'pmRecent', 'knownHeads', 'lastRoom'], function (r) {
        if (r.settings) {
          // The default theme moved to Big heads (labelled Default) in 0.9.71. A
          // stored 'classic' from before the move is the old default, not a choice
          // anyone made, so it moves too; an explicit pick of anything afterwards
          // stores themeMoved and is never touched again.
          if (!r.settings.themeMoved && r.settings.theme === 'classic') {
            r.settings.theme = 'bighead';
          }
          S.settings = Object.assign(S.settings, r.settings);
          // The feed is read on demand now, so its interval is not a setting any
          // more; a store written by an older build still has it, and merging it
          // back in would keep saving a value nothing reads.
          delete S.settings.pollMs;
          // Names are always asked for now. A store from a build that offered the
          // toggle may still carry a false, and leaving it there would keep a
          // feature switched off with no control left to switch it back on.
          delete S.settings.askNames;
        }
        // A line with no text is not a line. An older build could store one — it
        // trimmed a speaker's balloon-clear frame down to nothing and kept it — and
        // taking the scrollback verbatim meant every start since repainted those
        // blanks as if they had just been received. Drop them on the way in.
        //
        // The read can also land after the game has connected and the panel has
        // already written a line or two. Replacing the log with the stored one threw
        // those away — the same shape as the lastRoom bug below, and it lost the very
        // line that says where we are. So the two are merged, and anything the store
        // already has is not written twice.
        // The transcript survives sessions, but as one ordered log: stored lines come
        // first, then anything that already arrived on the wire, and a stored line is
        // never written twice.
        // Lines from a build that kept the switches in panel classes carry no flags:
        // they take the look the settings have on this load, which is what they were
        // showing. Everything written from here on stamps its own.
        S.irc.forEach(stampLook);
        if (r.irc && r.irc.length) {
          var have = {};
          S.irc.forEach(function (e) { have[e.t + ' ' + e.text] = 1; });
          var stored = r.irc.filter(ours).filter(function (e) {
            return !have[e.t + ' ' + e.text];
          }).map(function (e) {
            // Restored lines are immutable: the session that heard them is gone.
            e.committed = true;
            if (e.kind === 'earshot') e.kind = 'presence';   // the old name for it
            if (!Object.prototype.hasOwnProperty.call(e, 'headId')) e.headId = null;
            if (!Object.prototype.hasOwnProperty.call(e, 'headFixed')) e.headFixed = true;
            e._headArt = null;
            return e;
          });
          S.irc = stored.concat(S.irc).slice(-MAX_LINES);
        }
        if (r.pmRecent) S.pmRecent = r.pmRecent;
        // Faces from previous sessions, so a player whose record comes back without
        // schtick parts still wears the head they are known for.
        if (r.knownHeads && typeof r.knownHeads === 'object') {
          Object.keys(r.knownHeads).forEach(function (n) {
            if (typeof r.knownHeads[n] === 'number') recentHeads[n] = r.knownHeads[n];
          });
        }
        // Carrying the last session's room in means the first login frame of this one
        // can say "reconnected" rather than "entered" — and a different room is a
        // move out of where we really were, which the log already ends on. A login
        // frame can beat this read, though, and the room the wire named is the truth:
        // overwriting it forgot where we were and cost the next move its "you left".
        if (mySector === undefined && typeof r.lastRoom === 'number') mySector = r.lastRoom;
        applyGeometry();
        // A stored dock reserves the stage on load; the page's observer sees the
        // size change, but run its own fit once too so a side stored while the page
        // was elsewhere starts at the right place rather than a frame late.
        if (dockSide() !== 'float') relayoutPage();
        renderIrc();
        render();
        renderChatTargets();
        // A boot mark in the extension store is the only evidence a panel actually
        // ran: the tab cannot tell the browser from the outside, and "it is broken"
        // and "it never loaded" need different fixes. It carries the frame tallies
        // for the same reason: a log with no speech has to say whether no frame
        // arrived or a frame arrived undecoded.
        bootAt = Date.now();
        writeDiag();
        setInterval(writeDiag, 5000);
      });
    } catch (e) { /* ignore */ }
  }

  var bootAt = 0;
  var diagFrames = { n: 0, kinds: {}, types: {}, samples: [], out: 0, outDecoded: 0, outKinds: {}, outSamples: [], wadda: [], actorSamples: [] };
  var diagActors = { withHead: 0, withoutHead: 0, sample: [] };
  var diagErrors = [];
  // Failures the page reports on its own console. They are not exceptions this
  // script can throw, but they are exactly what a reader of the browser console
  // sees, so the diagnostics record keeps them; the MAIN-world agent forwards them.
  var diagPage = [];
  // How the face asks went: how many were sent, and which names were still
  // faceless when the recheck ran. This is the difference between "never asked"
  // and "asked and the server had nothing", which look identical on screen.
  var diagHeadAsks = 0;
  var diagHeadsWaited = [];
  var diagPushes = { n: 0, at: 0, lastKind: null, lastText: null };
  window.addEventListener('error', function (e) {
    if (diagErrors.length < 6) diagErrors.push('error: ' + String(e && e.message || e).slice(0, 160));
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (diagErrors.length < 6) diagErrors.push('reject: ' + String(e && e.reason && (e.reason.message || e.reason) || e).slice(0, 160));
  });

  /** ASCII-safe JSON, so the store can hold it without value-splitting noise. */
  function toB64(obj) {
    try {
      var s = JSON.stringify(obj);
      var bytes = new TextEncoder().encode(s);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    } catch (e) { return null; }
  }

  /**
   * Snapshot the live state into the extension store (see the diag reader in AGENTS.md).
   *
   * Small values go in diagJson and big byte dumps go in their own base64 keys: the
   * store splits long strings on disk, which made a mixed blob unreadable from a
   * profile read.
   */
  function writeDiag() {
    try {
      var lastLine = S.irc.length ? S.irc[S.irc.length - 1] : null;
      chrome.storage.local.set({
        diagJson: JSON.stringify({
          build: buildVersion(), boot: bootAt, now: Date.now(),
          ready: !!agent.ready, canType: !!agent.canType, hasFs: !!agent.hasFs,
          user: agent.user || null, vw: window.innerWidth, vh: window.innerHeight,
          frames: diagFrames.n, kinds: diagFrames.kinds, types: diagFrames.types,
          outFrames: diagFrames.out, outDecoded: diagFrames.outDecoded,
          outKinds: diagFrames.outKinds,
          heads: Object.keys(heads).length, headArt: Object.keys(headArt).length, headArtPath: headArtPath,
          knownHeads: Object.keys(recentHeads).length,
          headAsk: { n: diagHeadAsks, waited: diagHeadsWaited.slice() },
          actors: diagActors, roomLines: S.irc.length,
          // The feed's own failure used to be printed in the settings sheet. With
          // that line gone this is the only place it can be read, and it still has
          // to be readable: a failed read is why the picker knows nobody.
          feed: { at: players.at || null, online: players.online.length, err: players.err || null },
          lastLine: lastLine && { t: lastLine.t, kind: lastLine.kind, nick: lastLine.nick, text: String(lastLine.text || '').slice(0, 60) },
          save: saveState, errors: diagErrors.slice(), page: diagPage.slice(), pushes: diagPushes,
          sendHook: !!agent.sendHook,
          waddaCount: diagFrames.wadda.length
        }),
        waddaB64: toB64(diagFrames.wadda),
        samplesB64: toB64({ speech: diagFrames.samples, out: diagFrames.outSamples, actors: diagFrames.actorSamples }),
        actorsB64: toB64(diagActors.sample)
      });
    } catch (e) { /* ignore */ }
  }

  /** The running build. A stale content script and a broken one look the same. */
  function buildVersion() {
    try { return 'v' + chrome.runtime.getManifest().version; } catch (e) { return 'v?'; }
  }

  /** Remember who we have just exchanged a private message with. */
  function notePmPartner(name) {
    if (!name || name === agent.user) return;
    S.pmRecent = [name].concat(S.pmRecent.filter(function (n) { return n !== name; })).slice(0, 8);
    save();
    renderChatTargets();
  }

  /**
   * Who the next message goes to. The first entry is public speech — which only
   * reaches players close enough to see the balloon, so it says that rather than
   * claiming the whole room. Below it come players we have just exchanged a
   * private message with, then everyone else online.
   *
   * The value lives in a hidden input, and the visible control is a button plus a
   * listbox. It is not a <select> because an <option> holds one run of text: the
   * room could not be dimmed or flushed right inside it, and both of those are the
   * point of showing it.
   */
  function renderChatTargets() {
    var input = root && root.getElementById('chat-to');
    var list = root && root.getElementById('chat-to-list');
    if (!input || !list) return;

    var online = players.online
      .map(function (p) { return p.name; })
      .filter(function (n) { return n !== agent.user; });
    // Somebody who is no longer listed is not a recipient any more.
    if (input.value && online.indexOf(input.value) < 0) input.value = '';

    paintTargetFace();
    // What the keyboard is on survives a repaint: a re-read that lands while the
    // list is open must not move the active row out from under it.
    var wasActive = targetValueAt(activeTarget);

    list.textContent = '';
    addTargetRow('', 'Say nearby', myRoomName());
    addTargetGroup('Recent', S.pmRecent.filter(function (n) { return online.indexOf(n) >= 0; }));
    addTargetGroup('Online', online.filter(function (n) { return S.pmRecent.indexOf(n) < 0; }).sort());

    var rows = targetRows();
    rows.forEach(function (r) {
      r.setAttribute('aria-selected', r.getAttribute('data-value') === input.value ? 'true' : 'false');
    });
    var again = -1;
    rows.forEach(function (r, i) { if (r.getAttribute('data-value') === wasActive) again = i; });
    activeTarget = again;
    if (targetsOpen) setActiveTarget(activeTarget < 0 ? 0 : activeTarget);
  }

  /* ------------------------------------------------------- recipient picker */

  var targetsOpen = false;      // the listbox is showing
  var activeTarget = -1;        // index of the row the keyboard is on

  /** The option rows, in order. */
  function targetRows() {
    var list = root && root.getElementById('chat-to-list');
    return list ? Array.prototype.slice.call(list.children).filter(function (c) {
      return c.classList && c.classList.contains('to-item');
    }) : [];
  }

  function targetValueAt(i) {
    var r = targetRows()[i];
    return r ? r.getAttribute('data-value') : null;
  }

  /** The chosen recipient: '' is public speech. */
  function pickedTarget() {
    var input = root && root.getElementById('chat-to');
    return input ? String(input.value || '') : '';
  }

  /**
   * The room a player was last seen in. The feed is the only thing that says where
   * somebody is, and it reports a sector; the name for that sector comes from
   * connect.dat, so one it does not name still shows as a number rather than being
   * left out — "sector 51" is worth more than nothing at all.
   */
  function lastSeen(sector) {
    if (sector == null || sector === '') return '';
    return roomLabel(sector) || 'sector ' + sector;
  }

  /** Our own room's name, which is where "Say nearby" actually reaches. */
  function myRoomName() {
    return mySector === undefined ? '' : roomLabel(mySector);
  }

  /** The "(here)" mark: the feed's sector for them against the room the wire named. */
  function roomCellFor(name) {
    var p = players.online.filter(function (x) { return x.name === name; })[0];
    if (name === '' || !p) return '';
    var here = mySector !== undefined && p.sector === mySector;
    return (lastSeen(p.sector) + (here ? ' (here)' : '')).trim();
  }

  /**
   * One row: the name, then the room, which the stylesheet dims and flushes right —
   * no divider between them, the alignment does that job.
   */
  function addTargetRow(value, nick, room) {
    var list = root.getElementById('chat-to-list');
    if (!list) return;
    var row = el('div', {
      class: 'to-item', id: 'to-opt-' + targetRows().length, role: 'option',
      'data-value': value, 'aria-selected': 'false',
      onclick: function () { pickTarget(value); }
    }, [
      el('span', { class: 'to-nick', text: nick }),
      el('span', { class: 'to-room', text: room || '' })
    ]);
    list.appendChild(row);
  }

  function addTargetGroup(label, names) {
    if (!names.length) return;
    var list = root.getElementById('chat-to-list');
    if (!list) return;
    list.appendChild(el('div', { class: 'to-group', text: label, role: 'presentation' }));
    names.forEach(function (n) { addTargetRow(n, n, roomCellFor(n)); });
  }

  /** The closed control: who is chosen, and where they were last seen. */
  function paintTargetFace() {
    var nick = root && root.getElementById('chat-to-nick');
    var room = root && root.getElementById('chat-to-room');
    if (!nick || !room) return;
    var value = pickedTarget();
    nick.textContent = value || 'Say nearby';
    room.textContent = value ? roomCellFor(value) : myRoomName();
  }

  /** Choose a recipient and hand the keyboard back to the message box. */
  function pickTarget(value) {
    var input = root.getElementById('chat-to');
    if (input) input.value = value == null ? '' : value;
    closeTargets();
    paintTargetFace();
    var rows = targetRows();
    rows.forEach(function (r) {
      r.setAttribute('aria-selected', r.getAttribute('data-value') === pickedTarget() ? 'true' : 'false');
    });
    var text = root.getElementById('chat-text');
    if (text && text.focus) text.focus();
  }

  function setActiveTarget(i) {
    var rows = targetRows();
    if (!rows.length) return;
    activeTarget = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach(function (r, n) {
      if (n === activeTarget) r.classList.add('active'); else r.classList.remove('active');
    });
    var face = root.getElementById('chat-to-face');
    if (face) face.setAttribute('aria-activedescendant', rows[activeTarget].getAttribute('id'));
    if (rows[activeTarget].scrollIntoView) rows[activeTarget].scrollIntoView({ block: 'nearest' });
  }

  function openTargets() {
    var list = root.getElementById('chat-to-list');
    var face = root.getElementById('chat-to-face');
    if (!list || !face || targetsOpen) return;
    targetsOpen = true;
    list.hidden = false;
    face.setAttribute('aria-expanded', 'true');
    // Fresh at the moment of use, and the same read the hover warm-up would do.
    wantPlayers();
    var at = 0;
    targetRows().forEach(function (r, i) { if (r.getAttribute('data-value') === pickedTarget()) at = i; });
    setActiveTarget(at);
    // The pane clips, and the list opens upward, so give it exactly the room that
    // exists above the compose row instead of a viewport-based guess.
    var wrap = root.getElementById('chat-to-wrap');
    var body = root.getElementById('content');
    var box = wrap && wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
    var top = body && body.getBoundingClientRect ? body.getBoundingClientRect() : null;
    if (box && top && box.top > 0 && top.top >= 0) {
      list.style.maxHeight = Math.max(90, Math.round(box.top - top.top - 10)) + 'px';
    }
    document.addEventListener('pointerdown', awayFromTargets, true);
  }

  function closeTargets() {
    if (!targetsOpen) return;
    targetsOpen = false;
    var list = root.getElementById('chat-to-list');
    var face = root.getElementById('chat-to-face');
    if (list) list.hidden = true;
    if (face) { face.setAttribute('aria-expanded', 'false'); face.removeAttribute('aria-activedescendant'); }
    document.removeEventListener('pointerdown', awayFromTargets, true);
  }

  function toggleTargets(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (targetsOpen) closeTargets(); else openTargets();
  }

  /** A click anywhere else puts the list away, panel or page alike. */
  function awayFromTargets(e) {
    var wrap = root.getElementById('chat-to-wrap');
    if (!wrap) return closeTargets();
    var path = e && e.composedPath && e.composedPath();
    if (path && path.length) {
      if (path.indexOf(wrap) < 0) closeTargets();
      return;
    }
    var t = e && e.target;
    if (!(t && wrap.contains && wrap.contains(t))) closeTargets();
  }

  /**
   * Keys on the closed control open it; keys on the open list steer it.
   *
   * The arrows are deliberately not a way in. They belong to the game while you are
   * typing — that is how you keep walking with the chat box focused — so only Enter
   * and Space open the picker, and the arrows steer once it is open.
   */
  function targetsKey(e) {
    var k = e.key;
    var enter = k === 'Enter' || k === ' ' || k === 'Spacebar';
    if (!targetsOpen) {
      if (!enter) return;
      e.preventDefault(); e.stopPropagation(); openTargets();
      return;
    }
    if (k === 'ArrowDown') setActiveTarget(activeTarget + 1);
    else if (k === 'ArrowUp') setActiveTarget(activeTarget - 1);
    else if (k === 'Home') setActiveTarget(0);
    else if (k === 'End') setActiveTarget(targetRows().length - 1);
    else if (enter) {
      var value = targetValueAt(activeTarget);
      if (value != null) pickTarget(value);
    }
    else if (k === 'Escape') closeTargets();
    else if (k === 'Tab') { closeTargets(); return; }   // and let focus move on
    else return;
    e.preventDefault(); e.stopPropagation();
  }

  /* ----------------------------------------------------------------- bridge */

  /** False once a fresh injection has taken the page over from this panel. */
  function current() { return !!(host && host.isConnected); }

  function cmd(name, args, timeoutMs) {
    args = args || {};
    return new Promise(function (res) {
      var id = ++seq;
      var msg = { k: 'cmd', id: id, cmd: name, args: args };
      msg[CH] = 1; // the agent ignores anything without this marker
      var timeout = timeoutMs == null ? 5000 : timeoutMs;
      var timer = setTimeout(function () {
        if (pending.delete(id)) res(null);
      }, timeout);
      pending.set(id, function (value) {
        clearTimeout(timer);
        res(value);
      });
      try { window.postMessage(msg, location.origin); }
      catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        res(null);
      }
    });
  }

  window.addEventListener('message', function (ev) {
    // Firefox reports null for postMessage events crossing an extension/content-script boundary.
    if (ev.source !== null && ev.source !== window) return;
    if (ev.origin !== location.origin) return;
    if (!current()) return;               // a newer panel owns this page now
    var d = ev.data;
    if (!d || d[CH] !== 1) return;

    if (d.k === 'reply') {
      var r = pending.get(d.id);
      if (r) { pending.delete(d.id); r(d.value); }
    } else if (d.k === 'ready') {
      Object.assign(agent, d.status, { ready: true });
      loadRooms();
      loadHeads();
      render();
    } else if (d.k === 'state') {
      agent.state = d.state;
    } else if (d.k === 'frame') {
      try { onFrame(d.frame); } catch (e) { reportError('frames', e); }
    } else if (d.k === 'room') {
      // A new sector server means the player moved rooms. Everything scoped to the old
      // room is dropped here, and the recipient list is re-read as the feed catches up.
      onRoomChange();
    } else if (d.k === 'console') {
      // The page's own console output: the agent repeats the last few distinct
      // lines, so this is a running tally rather than an append log.
      diagPage = Array.isArray(d.errors) ? d.errors.slice(0, 8) : [];
    } else if (d.k === 'sock') {
      // A room socket closed. Not yet a disconnect: moving rooms closes the old one
      // too, and the login for the next room follows within the same second.
      noteDropped();
    }
  });

  function onFrame(f) {
    diagFrames.n++;
    if (f.dir === 'out') {
      diagFrames.out++;
      // A WDDA frame is the client speaking. Keep a few raw ones: outbound speech
      // decoding is the one path the transcript still loses.
      if (f.hex && String(f.hex).indexOf('57 44 44 41') >= 0 && diagFrames.wadda.length < 3) {
        diagFrames.wadda.push({
          type: f.type, n: f.n,
          kinds: f.decoded ? f.decoded.map(function (x) { return x.kind; }) : [],
          hex: String(f.hex).slice(0, 200)
        });
      }
      if (f.decoded) {
        diagFrames.outDecoded++;
        f.decoded.forEach(function (d) {
          diagFrames.outKinds[d.kind] = (diagFrames.outKinds[d.kind] || 0) + 1;
        });
      } else if (f.hex && diagFrames.outSamples.length < 3) {
        // An outbound frame the decoder refused is the only way to see why our own
        // lines are missing from the transcript.
        diagFrames.outSamples.push(String(f.hex).slice(0, 160));
      }
    }
    // Keep the raw shape of speech-channel frames: a decoder that rejects a real
    // word is invisible from the transcript, and the bytes are the only way to fix it.
    if (typeof f.type === 'number') {
      diagFrames.types[f.type] = (diagFrames.types[f.type] || 0) + 1;
      if (f.type === 0 && f.hex && diagFrames.samples.length < 4) {
        diagFrames.samples.push(String(f.hex).slice(0, 220));
      }
    }
    if (f.decoded) {
      f.decoded.forEach(function (d) {
        diagFrames.kinds[d.kind] = (diagFrames.kinds[d.kind] || 0) + 1;
      });
    }
    // A name record with no schtick parts is the one thing that leaves a player
    // faceless, and the raw window is the only way to tell "the server did not send
    // them" from "they are at an offset we do not read". Any frame that named
    // somebody it could not dress is sampled: the frame's own type is only its first
    // message's (a roster frame leads with the sector list), so filtering on it
    // sampled the map and missed the records that mattered.
    if (f.hex && f.decoded && diagFrames.actorSamples.length < 3) {
      for (var a = 0; a < f.decoded.length; a++) {
        var rec = f.decoded[a];
        if (rec.kind !== 'actors') continue;
        for (var x = 0; x < rec.list.length; x++) {
          if (rec.list[x].head == null && rec.list[x].probe) {
            diagFrames.actorSamples.push({
              name: rec.list[x].name, id: rec.list[x].id, probe: rec.list[x].probe,
              hex: String(f.hex).slice(0, 400)
            });
            a = f.decoded.length;
            break;
          }
        }
      }
    }
    if (S.captureOn) {
      S.capture.push(f);
      if (S.capture.length > 4000) S.capture.shift();
    }
    if (f.decoded) ircFromFrame(f);
  }

  /* --------------------------------------------------------- Chat transcript */

  /**
   * The box is for the room. Public speech is not a protocol frame the extension
   * sends — you raise a speech balloon by typing into the game, so outgoing room
   * messages are echoed locally and typed into the game. Private messages are the
   * 0x19/0x1a pair and are decoded off the wire in both directions.
   */
  function ircFromFrame(f) {
    var added = false;
    f.decoded.forEach(function (d) {
      if (d.kind === 'actors') {
        var newHead = false;
        d.list.forEach(function (a) {
          // Whether the wire actually names a head is the whole question behind
          // missing schtick faces; the art itself is proven readable.
          if (a.head != null) diagActors.withHead++; else diagActors.withoutHead++;
          if (diagActors.sample.length < 4) {
            diagActors.sample.push({
              id: String(a.id || ''), name: String(a.name || ''), head: a.head == null ? null : a.head,
              live: !!d.live, probe: a.probe || null
            });
          }
          // A room reuses ids. A live record that gives this id a different name
          // means its previous occupant is gone even if we never saw the departure,
          // so their lines are settled before the new name is adopted.
          var was = actorNames[a.id];
          if (d.live && was && a.name && was !== a.name) {
            if (freezeHeads(function (e) { return e.actor === tagOf(a.id); })) newHead = true;
          }
          actorNames[a.id] = a.name;
          // The head comes off the same record as the name, so a speaker's face is
          // known the moment they are. Lines already on screen were painted without
          // it, so a head we have not seen before repaints the log.
          if (a.head != null) {
            if (heads[a.name] !== a.head) newHead = true;
            heads[a.name] = a.head;
            delete recentHeads[a.name];     // re-add, so "recent" stays true for trimming
            recentHeads[a.name] = a.head;
          } else if (a.name && a.name !== agent.user && recentHeads[a.name] == null) {
            // The record named them without schtick parts. The game only sends parts
            // when it is asked, so ask — a player can be named long before they speak,
            // and a speaker who never asked again stayed faceless.
            askForHead(a.name);
          }
          // Name/head data may settle an open line, but committed history is final.
          S.irc.forEach(function (e) {
            // A line whose actor left, or whose room we left, has a settled identity:
            // the next player to wear this id is somebody else.
            if (e.headFixed) return;
            if (e.gen != null && e.gen !== roomGen) return;   // ids are room-local
            if (e.actor === tagOf(a.id)) {
              if (e.committed) { fillName(e, a.name, a.head); return; }
              e.nick = a.name;
              if (a.head != null) e.headId = a.head;
            } else if (!e.actor && e.dir === 'out' && e.kind === 'say' && e.nick === a.name && a.head != null) {
              e.headId = a.head;
            }
          });
          // the 32-bit key is how a departure quotes this actor back, and how we
          // turn a bare key into a tag when no name record ever arrived
          if (a.key != null) {
            actorKeys[a.key] = a.id;
            if (a.key - a.id >= 0) keyBase = a.key - a.id;
          }
          // the roster we arrived to is a baseline, not arrivals; a live record is
          // somebody appearing, so their arrival still gets announced below
          if (d.live) return;
          seenActors[tagOf(a.id)] = true;
          notePresent(a.name);
        });
        relabelSpeakers();
        if (newHead) renderIrc();
        added = true;
      } else if (d.kind === 'room') {
        // Own room transition, straight off the wire.
        if (d.name && d.name !== agent.user) { agent.user = d.name; renderChatTargets(); }
        added = noteRoom(d.room) || added;
      } else if (d.kind === 'left') {
        added = noteLeave(d.key) || added;
      } else if (d.kind === 'speech') {
        pushSpeech(f, d);
        added = true;
      } else if (d.kind === 'move') {
        // Movement, not speech: a speaker's own line already says they are here, so
        // announcing them too would put a redundant line in front of every message.
        // Somebody who is present but silent is exactly what this adds.
        added = noteActor(d.actor, f.dir === 'out') || added;
      } else if (d.kind === 'send') {
        pushIrc({ t: f.t, kind: 'pm', dir: 'out', nick: agent.user || 'me', to: d.to, text: d.text });
        notePmPartner(d.to);
        added = true;
      } else if (d.kind === 'recv') {
        pushIrc({ t: f.t, kind: 'pm', dir: 'in', nick: d.from, text: d.text });
        notePmPartner(d.from);
        added = true;
      } else if (d.kind === 'info') {
        pushIrc({ t: f.t, kind: 'sys', text: 'PLAYER ' + d.name + ' IN ' + roomPhrase(d.sector) });
        added = true;
      } else if (d.kind === 'find') {
        pushIrc({ t: f.t, kind: 'sys', text: 'SEARCHING: ' + d.name });
        added = true;
      }
    });
    return added;
  }

  /**
   * Room speech is streamed one word per frame, and the protocol marks no end of
   * message — the balloon simply accumulates until the speaker stops. So words
   * are buffered per speaker and flushed on an idle gap. Measured against real
   * captures, words within one message arrive up to 1.1s apart while separate
   * messages are at least 2.2s apart, so the boundary is drawn between them.
   */
  // Line end is judged by shape, not only by time. A long line that ends in
  // punctuation reads as a finished sentence, so it can be closed sooner; anything
  // shorter, or with no punctuation, might still be going, so it waits longer.
  // Note the set: a trailing comma or semicolon means the sentence is still going,
  // so counting those as an end is how you split somebody mid-clause.
  // How long a silence ends a line. Both are a little longer than they used to be:
  // measured speech arrives in words with pauses of up to ~1.1s inside one message, and
  // the old gaps closed a line while the speaker was still drawing breath.
  var SPEECH_DONE = 1500;        // ends in punctuation, and long enough to be a sentence
  var SPEECH_IDLE = 3100;        // no punctuation, or too short to judge
  var SPEECH_MAX = 20000;        // the longest a single line may keep growing
  var SENTENCE_END = /[.!?][)"'\]]?$/;
  var speech = new Map();        // actor tag -> { parts, t, timer }
  var actorNames = {};           // actor id -> player name, from _actorName records
  // Actor key -> id, for the departure records (opcode 0x05), which carry the key
  // and nothing else. `keyBase` is the key space the room hands out: every actor
  // record seen so far puts an actor's key at 0x1e8412 + their id, in every session
  // and every room, so a departure is attributable even before a name record lands.
  // A record that disagrees corrects it.
  var actorKeys = {};
  var keyBase = 0x1e8412;
  // Actor ids are handed out by the room you are in, so the same id means a
  // different player in the next room. Everything is scoped to this generation
  // and the map is dropped on every room change, so a name can never leak across
  // a transition — nor rewrite the lines a previous room already wrote.
  var roomGen = 0;
  var recentHeads = {};             // name -> the head they last wore, kept between sessions
  var KNOWN_HEADS_MAX = 120;

  /** The remembered faces, trimmed to the most recent names, for storage. */
  function cappedHeads() {
    var out = {}, names = Object.keys(recentHeads);
    names.slice(-KNOWN_HEADS_MAX).forEach(function (n) { out[n] = recentHeads[n]; });
    return out;
  }

  /**
   * The server only sends _actorName records when the game asks for them, which
   * PgUp does (it also draws the names under each actor). Until this runs, or you
   * press PgUp yourself, another speaker can only be shown by their actor tag.
   *
   * This is not a setting. It was one while the press was believed to flash names
   * over every actor in the game window, but that press is a fallback that fires
   * only for the arrivals the server does not name by itself, so the flash is not
   * something a player can be expected to ever see — and a control whose effect
   * nobody can connect to anything is just clutter. Entry snapshots name everyone
   * already in the room, so what is left is the residue; the ask is what keeps it
   * from standing as a raw NRB tag with no speech face.
   */
  var namesAskedAt = 0;

  /**
   * Ask the game for names. Returns false when the ask was skipped rather than
   * sent, which is what lets a caller queue it instead of losing it.
   */
  function revealNames(force) {
    if (Date.now() - namesAskedAt < 5000) return false;   // one ask covers a burst
    // Only stand down when the state tap positively says the game is closed to
    // input. Firefox can miss that tap entirely, and gating on it there meant the
    // ask never happened and every speaker stayed a raw NRB tag.
    //
    // A forced ask (a face is missing for somebody already named) skips that flag:
    // it reports the StellaVision button, which is off during ordinary play, and
    // the ask is the only way the parts record is ever re-sent.
    if (!force && agent.state && !agent.state.en.stella) return false;
    namesAskedAt = Date.now();
    pressNames();
    return true;
  }

  async function pressNames() {
    try {
      for (var i = 0; i < NAMES_KEYS.length; i++) {
        await cmd('press', { sc: NAMES_KEYS[i] });
        await new Promise(function (r) { setTimeout(r, 220); });
      }
    } catch (e) { /* the game may refuse input; the next speaker retries */ }
  }
  var NAMES_KEYS = [75];   // PgUp reveals names

  /**
   * Names can arrive without heads.
   *
   * A roster record names everybody in the room, but the schtick parts are not on
   * every record that carries a name: measured on a live session, Helpbot and one
   * player came in with a name and no parts, while a record the same server sends
   * for the same Helpbot carries head 12. The server re-sends actor records when
   * the game asks for names — the same PgUp the unnamed-speaker path already uses
   * — so a speaker we can name but cannot draw gets that ask, once per session.
   * A player who genuinely wears no schtick simply stays faceless.
   */
  var headTries = {};       // name -> how many asks were actually sent
  var headQueue = [];       // names waiting for the ask limiter to pass
  var headTimer = null;
  var HEAD_ASK_RETRY = 5200;    // the names ask is one per five seconds
  var HEAD_ASK_RECHECK = 12000; // how long a record gets to come back
  var HEAD_ASK_MAX = 3;         // per name; a schtick-less player stops sooner

  /**
   * Queue one names ask for a speaker we can name but cannot draw.
   *
   * The ask is rate-limited to one per five seconds, so a busy room would silently
   * drop every name that arrived inside a burst — which is how a name ends up
   * marked as asked without anything ever being pressed. A skipped ask is queued
   * and retried when the window passes instead.
   */
  function askForHead(name) {
    if (!name || (headTries[name] || 0) >= HEAD_ASK_MAX) return;
    if (heads[name] != null || headQueue.indexOf(name) !== -1) return;
    headQueue.push(name);
    drainHeadAsks();
  }

  function drainHeadAsks() {
    if (headTimer || !headQueue.length) return;
    if (!revealNames(true)) {
      headTimer = setTimeout(function () { headTimer = null; drainHeadAsks(); }, HEAD_ASK_RETRY);
      return;
    }
    var name = headQueue.shift();
    headTries[name] = (headTries[name] || 0) + 1;
    diagHeadAsks++;
    // The press is fire-and-forget, and the game can swallow it — a balloon being
    // committed, a room still connecting. A name was previously asked once and
    // then trusted, so one lost press left that speaker faceless for the session.
    // Look for the head, and put the name back if it never arrived.
    setTimeout(function () { recheckHead(name); }, HEAD_ASK_RECHECK);
    if (headQueue.length) drainHeadAsks();     // schedules the next one past the window
  }

  function recheckHead(name) {
    if (!name || heads[name] != null) return;
    askForHead(name);                          // bounded by HEAD_ASK_MAX
    if (diagHeadsWaited.indexOf(name) === -1 && diagHeadsWaited.length < 6) diagHeadsWaited.push(name);
  }

  /** The tag every event carries for an actor: "NRB" + chr(id). */
  function tagOf(id) { return 'NRB' + String.fromCharCode(id); }

  /**
   * What a presence line calls somebody. A raw actor tag is an opaque room-local id —
   * half of them are control characters, and the printable ones read like a nickname
   * ("JOINED: NRBr"), which is exactly what nobody wants: a line saying a player
   * arrived should never be a line announcing an id. Speech keeps its tag, where it
   * is an honest marker of an unnamed voice and separates two of them; an arrival
   * that cannot be named says so in words, and is renamed the moment a record lands.
   */
  var UNNAMED = 'someone';

  /* A departure is written once per presence episode. The server repeats some frames,
     and its second copy can arrive after the id has already been reused — same key,
     same tag, different player — so a departure for a tag written moments ago is a
     copy, not an event. Long enough to cover a repeated frame, short enough that a
     genuine second departure is still announced. */
  var lastLeave = {};
  var LEAVE_COPY_MS = 2000;

  function presenceName(tag) {
    var id = String(tag || '').charCodeAt(3);
    return (id && actorNames[id]) || UNNAMED;
  }

  /**
   * StellaCenter (sector 78) is the hub, and the panel says nothing about it. You pass
   * through it on the way everywhere, so a line per event means two lines every trip
   * for a room you were only ever passing through, on top of a door that never stops
   * moving. Both of them are silent there: the ENTERING/LEAVING pair, and the
   * presence of everybody walking past. The roster line on arrival still is — who is
   * here is worth knowing, who walked past on their way somewhere else is not — and
   * the room itself is still tracked: the "(here)" marks, the room name in the
   * recipient list, the names and the faces. Every other room is unaffected, and the
   * settings switch still hides presence everywhere if that is wanted.
   */
  var QUIET_ROOM = { 78: 1 };              // sector 78, StellaCenter

  function quietRoom(n) { return QUIET_ROOM[n] === 1; }

  /** The same rule, for the room we are in: what presence is written against. */
  function quietHere() { return mySector !== undefined && quietRoom(mySector); }

  /**
   * Somebody we have not seen in this room spoke or moved, so they are here. This
   * lands the instant they do anything, rather than whenever the player feed next
   * updates — which is seconds late and useless for knowing who can hear you.
   */
  function noteActor(actor, mine) {
    if (mine || !actor || seenActors[actor]) return false;
    seenActors[actor] = true;
    // The server sends a name record as somebody appears (opcode 0x04), but not
    // always — captured, it arrived 2.3s before the movement. If there is still no
    // name, ask the game for one, exactly as an unnamed speaker does.
    if (!actorNames[String(actor).charCodeAt(3)]) revealNames();
    var name = presenceName(actor);
    if (!quietHere()) {
      pushIrc({
        t: Date.now(), kind: 'presence', gen: roomGen, actor: actor, nick: name,
        text: 'JOINED: ' + name
      });
    }
    return true;
  }

  /**
   * The other half of noteActor: opcode 0x05 says somebody left, and the payload is
   * only their actor key. Turning that back into a tag is what lets the departure
   * read as the same actor the arrival named.
   */
  /**
   * Freeze the heads of lines that can no longer learn one.
   *
   * Actor ids are room-local and the server reuses them, so a face is only safe to
   * fill in while its actor is still in the room: once somebody leaves, or we move,
   * a later record for the same id may be a different player, and repainting an old
   * line with it would wear the wrong face.
   */
  function freezeHeads(match) {
    var changed = false;
    S.irc.forEach(function (e) {
      if (!match(e) || e.headLocked) return;
      e.headFixed = true;           // the identity is settled with the face
      e.headLocked = true;          // and the face itself is final from here on
      changed = true;               // the flag is stored state, not just a guard
      // This is the last moment a head can be taken: whatever the name map knows
      // right now is committed to the line, and from here on the name map is not
      // allowed to paint it again. A line that still has none stays faceless.
      if (e.headId == null && e.nick && heads[e.nick] != null) e.headId = heads[e.nick];
    });
    return changed;
  }

  function noteLeave(key) {
    var id = actorKeys[key];
    if (id == null) id = key - keyBase;
    if (!(id > 0 && id < 256)) return false;
    var tag = tagOf(id);
    if (lastLeave[tag] && Date.now() - lastLeave[tag] < LEAVE_COPY_MS) return false;
    var name = presenceName(tag);
    // Whoever wears this id later is somebody else, and the name can be handed to
    // another player — either way this speaker's lines are finished.
    var known = name && name !== UNNAMED;
    // The server sends some frames twice, and a second departure for the same actor
    // arrives after the first one consumed the name — announcing "LEFT: someone" for
    // somebody we have already forgotten says nothing. An actor we never saw join
    // cannot be leaving either. Both are dropped; the first, named line stands.
    var wasSeen = !!seenActors[tag];
    // forget them, so walking back in is announced again rather than swallowed
    delete actorKeys[key];
    delete actorNames[id];
    delete seenActors[tag];
    if (!known && !wasSeen) return false;
    if (freezeHeads(function (e) { return e.actor === tag || (known && e.nick === name); })) {
      save();
      renderIrc();
    }
    if (!quietHere()) {
      lastLeave[tag] = Date.now();
      pushIrc({
        // Committed on write: a departure is history. The name it was written with is
        // what the panel knew then, and later records — a returning player, a reused
        // id, the map being cleared — must never rewrite it.
        t: Date.now(), kind: 'presence', leave: true, committed: true, gen: roomGen, actor: tag,
        nick: name, text: 'LEFT: ' + name
      });
    }
    return true;
  }

  /**
   * The occupants we walk in on. The server sends one record per actor — dozens
   * inside the same millisecond — so they are collected and written as a single
   * line once the burst settles: the base set that every later arrival and
   * departure then edits. Listed once per room, so a PgUp roster adds nothing.
   */
  var present = [];
  var presentTimer = null;
  var presentListed = false;

  function notePresent(name) {
    if (presentListed || !name || name === agent.user) return;   // we are not our own arrival
    if (present.indexOf(name) < 0) present.push(name);
    if (presentTimer) clearTimeout(presentTimer);
    presentTimer = setTimeout(flushPresent, 800);
  }

  function flushPresent() {
    presentTimer = null;
    if (presentListed || !present.length) return;
    presentListed = true;
    pushIrc({
      t: Date.now(), kind: 'presence', gen: roomGen,
      text: 'IN ROOM: ' + present.join(', ')
    });
  }

  /**
   * Our own connection, both ends.
   *
   * A room socket closing is the only evidence of going offline — nothing arrives on
   * a connection that is gone — but it is not proof on its own: moving rooms closes
   * the old socket too. So it waits out a grace period, and the login for the next
   * room cancels it. The client logging in again is the other end, and the room it
   * names says which kind of return it was.
   */
  var OFFLINE_GRACE = 1500;
  var offline = false;
  var offlineTimer = null;

  function noteDropped() {
    if (offline || offlineTimer) return;      // one line per outage, not one per socket
    offlineTimer = setTimeout(function () {
      offlineTimer = null;
      markOffline();
    }, OFFLINE_GRACE);
  }

  function markOffline() {
    offline = true;
    pushIrc({ t: Date.now(), kind: 'sys', text: 'DISCONNECTED' });
    save();
  }

  /** The page is going away, so a pending drop never gets its grace period. */
  function noteGone() {
    if (offline || mySector === undefined) return;
    if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
    markOffline();
  }

  /**
   * Our own room change. The client logs in to each room's server as it arrives, and
   * that frame names the room, so both ends of a move are written the moment it
   * happens — the feed is seconds behind and was only ever consulted because nothing
   * on the wire named a room. Logging in to the room we are already in is not a move:
   * the session was re-established, so it is a reconnection.
   */
  function noteRoom(n) {
    if (!n) return false;
    // Logging in at all is proof the connection is up, so a drop waiting out its
    // grace period was either a move or an outage short enough not to be worth a line.
    if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
    offline = false;
    if (n === mySector) {
      // A reconnect hands the room back with ids that may have changed hands while
      // we were away, so everything the log already says is final before the new
      // roster is read.
      if (freezeHeads(function () { return true; })) { save(); renderIrc(); }
      logRoom('RECONNECTED:', n);
      return true;
    }
    var was = mySector;
    mySector = n;
    teamAck = null;            // a new room gets its own warning
    save();
    renderChatTargets();       // the "(here)" marks move with us, not with the feed
    syncChatLock();
    if (was !== undefined) {
      flushAllSpeech();          // this room's open lines settle where they were written
      enterRoom();               // and every name we learned in it stops applying
      logRoom('LEAVING', was);
    }
    logRoom('ENTERING', n);
    return true;
  }

  /** Speech carries "NRB" + chr(id); the name records are the only source of names. */
  function speakerName(actor, mine) {
    if (mine) return agent.user || 'me';
    var id = String(actor || '').charCodeAt(3);
    return (id && actorNames[id]) || actor || '?';
  }

  function pushSpeech(f, d) {
    var buf = speech.get(d.actor);
    // A line is not allowed to grow forever. Twenty seconds of continuous speech is
    // the limit: past it the line is settled where it stands and this word starts a
    // new one, so a monologue is a column of readable lines rather than one of them.
    if (buf && f.t - buf.t >= SPEECH_MAX) {
      commitSpeech(d.actor);
      buf = null;
    }
    if (buf) {
      // The client does not only send the words as they are committed: when the
      // balloon is sent it hands over the whole line again. Appending that second
      // copy is what doubled a line into "hellooo… hellooo… bot" — the whole balloon
      // is longer than what we already have and starts with it, so it replaces the
      // text instead of being more of it. A chunk of the same length or shorter can
      // only be new words ("ha " + "ha "), and is still appended.
      if (d.text.length > buf.text.length && d.text.indexOf(buf.text) === 0) {
        buf.text = d.text;
      } else {
        buf.text += d.text;
      }
    } else {
      // The client sends a bare space on its own — captured as a WDDA frame whose
      // whole text is " ", once when the balloon opens and once when it closes. It
      // is not a message, and trimming it is what put an empty line under the
      // speaker's name. So a line is only ever opened by text there is something to
      // show: the entry is born with its text already in it, and a line with nothing
      // to say never reaches the log, not even for the instant before it is painted.
      var first = d.text.trim();
      if (!first) return;
      // The line opens on the first word and grows in place; the pause is what
      // submits it. Keyed by actor tag, so four people talking over each other
      // still get four lines, in the order they started.
      var mine = f.dir === 'out';
      buf = {
        t: f.t, timer: 0, mine: mine, text: d.text,
        entry: {
          t: f.t, kind: 'say', dir: mine ? 'out' : 'in', gen: roomGen,
          // Actor ids and the name/head records they resolve to are room-local.
          committed: false, nick: speakerName(d.actor, mine),
          headId: heads[speakerName(d.actor, mine)] == null
            ? recentHeads[speakerName(d.actor, mine)] == null ? null : recentHeads[speakerName(d.actor, mine)]
            : heads[speakerName(d.actor, mine)],
          actor: d.actor, text: first,
          // Was this speaker named when the line opened? A line that opens on a raw
          // actor tag stays a tag unless something can still name it (see fillName).
          named: !!actorNames[String(d.actor || '').charCodeAt(3)]
        }
      };
      stampLook(buf.entry);
      // A named speaker with no face is the case the ask was added for: the name
      // came from a record that did not carry the schtick parts.
      if (!mine && buf.entry.headId == null && buf.entry.nick && buf.entry.nick !== buf.entry.actor) {
        askForHead(buf.entry.nick);
      }
      speech.set(d.actor, buf);
      S.irc.push(buf.entry);
      while (S.irc.length > MAX_LINES) S.irc.shift();
      appendIrcLine(buf.entry);
      // The server only names actors when the game asks (PgUp), and it never
      // sends a record for yourself. So a player who walks in after the last
      // ask would speak under their raw tag forever; ask once per new speaker.
      if (!mine && !actorNames[String(d.actor || '').charCodeAt(3)]) revealNames();
    }
    buf.entry.text = buf.text.trim();
    paintIrcLine(buf.entry);
    clearTimeout(buf.timer);
    // entry.text is trimmed, so its last character is the last non-whitespace one.
    var line = buf.entry.text;
    var done = line.length > 10 && SENTENCE_END.test(line);
    buf.timer = setTimeout(function () { commitSpeech(d.actor); }, done ? SPEECH_DONE : SPEECH_IDLE);
  }

  /** Grow one line in place — re-rendering the log for every word would jank. */
  // Whether the log should follow new lines. Held as state rather than re-derived
  // from scrollTop every time: while the panel is hidden or mid-layout the geometry
  // reads as "at the bottom" and then reads as "not" once it is shown, so the log
  // stopped pegging for good. Only a real scroll by the reader clears it.
  var stick = true;

  function pegged(log) {
    return !log || log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  }

  function stickToBottom(log) {
    if (log) log.scrollTop = log.scrollHeight;
  }

  function paintIrcLine(entry) {
    if (!entry._msg) return;
    // The text grows, which makes the log taller and slides the view off the
    // bottom; a reader who was following it is carried down. Someone reading back
    // through the history stays where they are.
    entry._msg.textContent = entry.text;
    if (stick) stickToBottom(root.getElementById('chatlog'));
  }

  /** The pause arrived: the line is submitted as it stands. */
  function commitSpeech(actor) {
    var buf = speech.get(actor);
    if (!buf) return;
    speech.delete(actor);
    clearTimeout(buf.timer);
    // The line is settled: this is when it ended, and it goes on the stamp it started
    // at. Written onto the node already up rather than by re-rendering, which would
    // rebuild the whole log for every message that finishes.
    buf.entry.ended = Date.now();
    if (!buf.entry.text) {                       // nothing ever arrived
      var i = S.irc.indexOf(buf.entry);
      if (i >= 0) S.irc.splice(i, 1);
      renderIrc();
    } else {
      // the row, not the stamp: the stamp may not exist at all, and the row is what
      // a hover lands on
      if (buf.entry._ts) buf.entry._ts.setAttribute('title', stampTitle(buf.entry));
      // Freeze transcript metadata at commit, regardless of avatar load timing.
      buf.entry.committed = true;
      var id = buf.entry.headId;
      if (id != null && headArt[id]) buf.entry._headArt = headArt[id];
    }
    save();
  }

  /**
   * Names arrive after the speech they belong to, so fix the lines already up —
   * but only this room's. An older line is settled: relabelling it from the
   * current map is how a room change used to rewrite the whole scrollback.
   */
  /**
   * Give an unnamed line its speaker's name and face.
   *
   * Committed text is final, but an identity that was never learned is not history —
   * leaving it is how a whole session reads "NRBs: hello" with no face. Filling only
   * blanks keeps the rule that mattered: a reused room actor id can never repaint a
   * line that already had a name and a head.
   */
  function fillName(e, name, head) {
    if (!e || e.kind !== 'say' || e.dir !== 'in') return false;
    if (e.gen != null && e.gen !== roomGen) return false;   // ids are room-local
    if (e.headFixed) return false;
    var changed = false;
    var tagged = !e.nick || e.nick === '?' || e.nick === e.actor;
    if (!e.named && name && tagged) { e.nick = name; e.named = true; changed = true; }
    // A name can arrive before the head does, and the head is what is still missing
    // here; a line that already has a head is never repainted with another one.
    if (head != null && e.headId == null) { e.headId = head; changed = true; }
    if (changed) { save(); renderIrc(); }
    return changed;
  }

  function relabelSpeakers() {
    var changed = false;
    S.irc.forEach(function (e) {
      if (e.headFixed) return;                 // this line's identity is settled
      if (e.committed) {
        if (e.kind === 'say' && e.dir === 'in') {
          var committedName = actorNames[String(e.actor || '').charCodeAt(3)];
          fillName(e, committedName, committedName == null ? null : heads[committedName]);
        }
        return;
      }
      if (e.kind === 'say' && e.dir === 'out') {
        if (e.nick !== agent.user) { e.nick = agent.user || 'me'; changed = true; }
        if (recentHeads[e.nick] != null && e.headId !== recentHeads[e.nick]) { e.headId = recentHeads[e.nick]; changed = true; }
        return;
      }
      if (e.dir === 'out' || !e.actor || e.gen !== roomGen) return;
      // A departure is committed: presenceName() reads the map as it is NOW, so
      // recomputing an old line is how "LEFT: Timmy3XUJW" became "LEFT: someone"
      // (the name had been deleted) or the name of whoever next wore that id.
      if (e.kind === 'presence' && e.leave) return;
      // an arrival logged under a tag is rewritten once the name record lands
      if (e.kind === 'presence') {
        var n = presenceName(e.actor);
        var t = (e.leave ? 'LEFT: ' : 'JOINED: ') + n;
        if (n !== e.nick || e.text !== t) { e.nick = n; e.text = t; changed = true; }
        return;
      }
      if (e.kind !== 'say') return;
      var name = actorNames[String(e.actor).charCodeAt(3)];
      if (name && name !== e.nick) {
        e.nick = name;
        e.headId = heads[name];
        changed = true;
      }
    });
    if (changed) { save(); renderIrc(); }
  }

  function flushAllSpeech() {
    Array.from(speech.keys()).forEach(commitSpeech);
  }

  function pushIrc(entry) {
    if (!entry.text) return;                     // never write a line nobody can read
    stampLook(entry);
    var last = S.irc[S.irc.length - 1];
    // The same frame twice is one line. The actor is part of the key: two arrivals
    // that cannot be named yet both read "JOINED: someone", and collapsing those
    // would swallow a real one.
    if (last && last.kind === entry.kind && last.text === entry.text && last.nick === entry.nick &&
        last.actor === entry.actor && entry.t - last.t < 1500) return;
    S.irc.push(entry);
    while (S.irc.length > MAX_LINES) S.irc.shift();
    diagPushes.n++;
    diagPushes.at = Date.now();
    diagPushes.lastKind = entry.kind;
    diagPushes.lastText = String(entry.text || '').slice(0, 60);
    save();
    appendIrcLine(entry);
  }

  /**
   * Stable per-speaker colour. The lightness is a token so a light theme can darken
   * the whole set at once — a pastel mixed for a black log is unreadable on cream —
   * and it is used directly, not aliased, so the theme's value is the one that lands.
   */
  function nickColor(nick) {
    var h = 0;
    for (var i = 0; i < nick.length; i++) h = (h * 31 + nick.charCodeAt(i)) >>> 0;
    return 'hsl(' + (h % 360) + ' 62% var(--nick-l, 70%))';
  }

  /** A full local time. The visible stamp is minutes only; the alt text is not. */
  function stamp(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /**
   * What a line's title says on hover: when it started, when it settled, and — for a
   * room change — the sector, which is kept out of the line itself.
   */
  function stampTitle(e) {
    var when = e.ended ? stamp(e.t) + ' – ' + stamp(e.ended) : stamp(e.t);
    return e.sector == null ? when : when + ' · sector ' + e.sector;
  }

  /** A speaker's colour, or the plain foreground for a line written without them. */
  function nickStyle(nick, colour) {
    return 'color:' + (colour === false ? 'var(--fg)' : nickColor(nick || ''));
  }

  function chatLine(e) {
    if (e.hidden) return el('div', { class: 'irc hidden-line' });
    var line = el('div', { class: 'irc ' + e.kind + (e.dir ? ' ' + e.dir : '') + (e.nicks === false ? ' no-nick' : '') });
    // The stamp carries the time, not the row: a tooltip on the line turns every
    // hover into a clock, and it covers the words you were reading. Hovering the
    // stamp itself is the gesture — and because the big-head theme reveals the stamp
    // on hover, it is there to be hovered. No stamp (the setting is off) means no
    // tooltip, which is the honest consequence.
    // A message can take twenty seconds to arrive and the log has room for one time:
    // the one it started at. When it settled rides on that stamp as alt text, so the
    // line stays one line wide and the timing is still there to hover.
    var time = fmtTime(e.t);
    e._ts = null;
    if (time) {
      e._ts = el('span', { class: 'ts', text: time, title: stampTitle(e) });
      line.appendChild(e._ts);
    }
    // keep the message span so a line still being typed can be grown in place
    e._msg = null;
    if (e.kind === 'sys' || e.kind === 'presence') {
      e._msg = el('span', { class: 'msg', text: e.text });
      line.appendChild(e._msg);
    } else if (e.kind === 'pm' && e.dir === 'out') {
      // A committed identity is final, but a MISSING one is not an identity:
      // a session that painted this row before the recipient's face was known
      // stored null, and carrying that null forward forever is how a speaker
      // stays faceless across an upgrade. Fill a null once; a non-null frozen
      // head is never replaced here.
      if (e.toHeadId == null && recentHeads[e.to] != null) e.toHeadId = recentHeads[e.to];
      var toHead = e.heads === false ? null : headIcon(e.to, e, 'toHeadId');
      if (toHead) line.appendChild(toHead);
      if (e.nicks !== false) line.appendChild(el('span', { class: 'nick', text: 'TO ' + e.to + ':' }));
      e._msg = el('span', { class: 'msg', text: e.text });
      line.appendChild(e._msg);
    } else {
      // Room speech and incoming private messages share a plain inline username;
      // private messages remain distinguished by their (PM) mark.
      var nick = e.nick || '?';
      // always marked: a private message that reads like room talk is the one
      // mistake this line exists to prevent
      if (e.kind === 'pm') nick += ' (PM)';
      // Fill a missing head even on a settled identity: the text is history, a face
      // that arrived later is not — and headFixed does not block this, because a
      // stored null from an older session is not an identity to protect, and
      // filling it once is how a speaker stops being faceless after an upgrade.
      // headLocked is different: that line's owner left, moved, or reconnected, so
      // the name may already be somebody else and this face is final.
      if (!e.headLocked && e.headId == null && e.nick) {
        if (recentHeads[e.nick] != null) e.headId = recentHeads[e.nick];
        else if (heads[e.nick] != null) e.headId = heads[e.nick];
      }
      var face = e.heads === false ? null : headIcon(e.nick, e);
      if (face) line.appendChild(face);
      if (e.nicks !== false) line.appendChild(el('span', { class: 'nick', text: nick, style: nickStyle(e.nick, e.colour) }));
      e._msg = el('span', { class: 'msg', text: e.text });
      line.appendChild(e._msg);
    }
    return line;
  }

  function renderIrc() {
    var log = root && root.getElementById('chatlog');
    if (!log) return;
    log.textContent = '';
    S.irc.forEach(function (e) {
      // One line that cannot be painted must not take the whole transcript with it:
      // a throw here used to leave the log empty while the data said otherwise.
      try { log.appendChild(chatLine(e)); } catch (err) { reportError('line', err); }
    });
    if (stick) stickToBottom(log);
  }

  /**
   * Add one line without rebuilding the log. A new speaker used to repaint the
   * whole scrollback, which is visible as a jump every time somebody starts
   * talking — the exact moment you are reading it.
   */
  function appendIrcLine(entry) {
    var log = root && root.getElementById('chatlog');
    if (!log) return;
    try { log.appendChild(chatLine(entry)); } catch (err) { reportError('line', err); return; }
    // `children` is an HTMLCollection: a length and an index, and no shift(). Trimming
    // it with one threw the instant the log passed 300 lines, and the throw landed
    // inside whoever was writing — a move got its "you left" in and died before its
    // "you entered", so the arrival was simply never written. Nothing said so: the
    // line was already in the log, so it looked like the panel had chosen to omit it.
    while (log.children.length > MAX_LINES) log.removeChild(log.children[0]);
    if (stick) stickToBottom(log);
  }

  /**
   * Send what is in the box. An empty "to" talks to the room through game input;
   * the WebSocket tee captures its outbound speech frame as the single transcript
   * entry. Named recipients send a private message over the decoded 0x19 frame.
   */
  function printableAscii(text) {
    return typeof text === 'string' && /^[\x20-\x7e]*$/.test(text);
  }

  function sendTimeout(text) {
    // A character takes 130ms, with one final wait before the commit; leave room
    // for page scheduling and IPC jitter. Other bridge commands keep the short cap.
    return Math.max(5000, (String(text || '').length + 2) * 130 + 5000);
  }

  function restoreDraft(input, submitted) {
    if (!input.value) input.value = submitted;
  }

  // The client's own private-message body cap (agent.js MAX_TEXT, the same 180
  // the 0x19 frame and the protocol codec enforce). A longer draft is split into
  // several messages at this size rather than refused: the game sends them as
  // separate radio balloons, exactly as if each had been typed on its own.
  var PM_LIMIT = 180;

  /**
   * A draft cut into client-sized pieces, breaking between words where it can.
   * Only a single run longer than the limit is cut mid-word, because there is no
   * word boundary to honour inside it.
   */
  function splitPm(text) {
    var out = [];
    var rest = String(text).replace(/\s+/g, ' ').trim();
    while (rest.length > PM_LIMIT) {
      var cut = rest.lastIndexOf(' ', PM_LIMIT);
      if (cut <= 0) cut = PM_LIMIT;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  async function sendChat() {
    if (sending) return;
    if (lockedHere()) return;      // the box is hidden; a stale Enter must not type
    var input = root.getElementById('chat-text');
    var text = input.value.trim();
    var to = pickedTarget().trim();
    if (!text) return;
    if (to) {
      if (!agent.ready) return toast('The game is still loading; your message was not sent.');
      if (!printableAscii(text) || !printableAscii(to)) {
        return toast('Private messages support printable ASCII characters only.');
      }
      if (to.length > 31) return toast('Recipient names must be 31 characters or fewer.');
      // Anything the client would refuse on length is sent as several messages of
      // the client's own size instead. Each one arrives as its own radio balloon.
      var parts = splitPm(text);
      sending = true;
      var sent = 0;
      var failure = null;
      try {
        for (var i = 0; i < parts.length; i++) {
          var r = await cmd('sendMessage', { to: to, text: parts[i] });
          if (!r || !r.ok) { failure = (r && r.error) || 'no reply from the page'; break; }
          sent++;
        }
      } finally { sending = false; }
      if (failure) {
        // Only what was not sent goes back in the box: restoring the whole draft
        // would send the delivered messages again on retry. An edit made while the
        // sends were in flight is the user's and is never overwritten.
        var left = sent ? parts.slice(sent).join(' ') : text;
        if (!input.value || input.value.trim() === text) input.value = left;
        toast(sent
          ? 'Sent ' + sent + ' of ' + parts.length + ' messages: ' + failure
          : 'Private message failed: ' + failure);
      } else {
        if (input.value.trim() === text) input.value = '';
        if (parts.length > 1) toast('Sent ' + parts.length + ' messages (' + PM_LIMIT + ' characters each).');
      }
      return;
    }

    if (!agent.ready || !agent.canType) {
      return toast('The game is still loading; your message was not sent.');
    }
    if (agent.state && !agent.state.en.stella) {
      return toast('Game is not accepting input right now.');
    }
    if (!printableAscii(text)) {
      return toast('Room chat supports printable US-ASCII characters only.');
    }
    if (text.length > 120) return toast('Room messages are limited to 120 characters.');

    // Lock immediately so two independent game-input sequences cannot overlap.
    // Keep the draft visible while the in-game keyboard receives it.
    sending = true;
    var sendButton = root.getElementById('chat-send');
    sendButton.disabled = true;
    sendButton.textContent = 'Sending…';
    var said;
    try { said = await cmd('say', { text: text }, sendTimeout(text)); }
    finally {
      sending = false;
      if (sendButton && sendButton.isConnected) {
        sendButton.disabled = false;
        sendButton.textContent = 'Send';
      }
    }
    if (said && said.ok && said.typed === text.length) {
      if (input.value.trim() === text) input.value = '';
      return;
    }
    // Only what the game never received goes back in the box: the characters it
    // already holds are in the balloon, and retrying the whole draft would type
    // them a second time.
    var typed = (said && said.typed) || 0;
    restoreDraft(input, text.slice(typed));
    var why = (said && said.error) || 'Could not type the complete message into the game.';
    toast(typed ? why + ' ' + typed + ' of ' + text.length + ' characters are already typed there.' : why);
    // The game's outbound WDDA frames are already captured by the WebSocket tee.
    // Do not add an optimistic copy here: that duplicates the same speech.
  }

  /* ----------------------------------------------------------- schtick heads */

  /**
   * A player's head is one of the 37 directories under /release/art/schtick/heads,
   * and the game already has every one of those files in its own filesystem — the
   * same preloaded package connect.dat comes out of. So the art costs one FS read
   * and no request of its own.
   *
   * The frames are 8-bit BMPs with the pixels run-length coded (BI_RLE8) and
   * palette index 63 as the colour key, so an <img> would paint a blue box around
   * every face. They are decoded here instead and keyed out into RGBA, which a
   * canvas rasterises and writes as a PNG (see pngUrl).
   * The key is taken by INDEX and not by colour: entry 63 is #0800ff on most
   * heads but #0000ff on h15bat and #0100ff on h37pumphead, so matching the
   * colour would have left two heads wearing a blue square.
   */
  var HEADS_PATH = '/release/art/schtick/heads';
  var KEY_INDEX = 63;                       // the engine's transparent colour
  // The frame to wear in a log line: standing and facing us, then whatever the
  // head has. h16potato has no s-frame at all, hence the fallbacks.
  var FRAME_ORDER = ['s01', 's02', 's03', 'h01', 'e01', 'w01', 'd01', 't01', 'i01', 'j01'];

  var headDirs = null;                      // head id -> directory name
  var headArt = {};                         // head id -> { w, h, data } decoded RGBA
  var headPending = {};                     // head id -> a read is already in flight
  var headBad = {};                         // head id -> its bytes are not a BMP we read
  var heads = {};                           // nick -> head id, once something knows one

  var headsTries = 0;
  var headArtPath = null;                // 'canvas' or 'bmp', whichever drew the art

  async function loadHeads() {
    if (headDirs || headsLoading) return;
    headsLoading = true;
    var names = null;
    try { names = await cmd('readDir', { path: HEADS_PATH }); }
    finally { headsLoading = false; }
    if (!names) {
      // The filesystem is not mounted yet. A read that said nothing is not an
      // answer, so this retries rather than latching with no art for the session.
      if (++headsTries < 5) setTimeout(loadHeads, 2000);
      return;
    }
    var dirs = {};
    names.forEach(function (n) {
      var m = /^h(\d+)/i.exec(n);
      if (m) dirs[Number(m[1])] = n;
    });
    if (Object.keys(dirs).length) {
      headDirs = dirs;
      // Every line already up asked for its head before this list existed and was
      // told no. Now headPath can answer, so ask again.
      renderIrc();
    }
  }

  /** The file for a head, or null when that id has no art or no frame we know. */
  async function headPath(id) {
    var dir = headDirs && headDirs[id];
    if (!dir) return null;
    var files = await cmd('readDir', { path: HEADS_PATH + '/' + dir });
    if (!files) return null;
    var pre = (/^h\d+/i.exec(dir) || [''])[0].toLowerCase();
    var lower = files.map(function (f) { return String(f).toLowerCase(); });
    for (var i = 0; i < FRAME_ORDER.length; i++) {
      var j = lower.indexOf(pre + FRAME_ORDER[i] + '.bmp');
      if (j >= 0) return HEADS_PATH + '/' + dir + '/' + files[j];
    }
    return null;
  }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  /**
   * BI_RLE8, bottom-up: [count][value] is a run, [0][n] a literal run, [0][0] the
   * end of a line and [0][1] the end of the image.
   */
  function rle8(b, off, w, h, px) {
    var p = off, x = 0, y = h - 1;
    while (p + 1 < b.length) {
      var n = b[p++], v = b[p++];
      if (n > 0) {
        while (n-- > 0 && x < w) px[y * w + x++] = v;
      } else if (v === 0) {
        x = 0; y--;
      } else if (v === 1) {
        return true;
      } else if (v === 2) {
        if (p + 1 >= b.length) return false;
        x += b[p++]; y -= b[p++];
      } else {
        if (p + v > b.length) return false;
        for (var k = 0; k < v; k++) if (x < w) px[y * w + x++] = b[p + k];
        p += v + (v & 1);                    // literal runs are padded to even
      }
      if (y < 0) return true;
    }
    return true;
  }

  /**
   * An 8-bit BMP to RGBA, with the colour key punched out. Anything we do not
   * understand returns null, which reads as "no icon" rather than a broken image.
   */
  function bmpToRGBA(b) {
    if (!b || b.length < 54) return null;
    var off = u32(b, 10), w = u32(b, 18), h = u32(b, 22), bpp = u16(b, 28), comp = u32(b, 30);
    if (bpp !== 8 || w < 1 || h < 1 || w > 256 || h > 256) return null;
    if (54 + 1024 > b.length) return null;

    var px = new Uint8Array(w * h);
    if (comp === 1) {
      if (!rle8(b, off, w, h, px)) return null;
    } else if (comp === 0) {
      var stride = Math.ceil(w / 4) * 4;
      if (off + stride * h > b.length) return null;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) px[(h - 1 - y) * w + x] = b[off + y * stride + x];
      }
    } else {
      return null;
    }

    var data = new Uint8ClampedArray(w * h * 4);
    for (var i = 0; i < w * h; i++) {
      var c = px[i], o = 54 + c * 4, q = i * 4;
      data[q] = b[o + 2];
      data[q + 1] = b[o + 1];
      data[q + 2] = b[o];
      data[q + 3] = c === KEY_INDEX ? 0 : 255;
    }
    return { w: w, h: h, data: data };
  }

  /** Read and decode one head, once, then repaint so its lines can wear it. */
  function ensureHead(id) {
    // A head whose bytes are not a BMP we understand is settled: it is asked for
    // once, not on every repaint of the log.
    if (headArt[id] || headPending[id] || headBad[id]) return;
    headPending[id] = true;
    headPath(id).then(function (path) {
      return path ? cmd('readBytes', { path: path }) : null;
    }).then(function (bytes) {
      var art = bmpToRGBA(bytes);
      // No art is not the same as no such art. The first lines are painted while the
      // head directory is still being read, and headPath cannot name a file before it
      // knows the directory — so this returns empty-handed on a page that has just
      // loaded. Holding the pending flag through that left every restored line
      // faceless for the whole session, with the bytes sitting right there in the
      // game's own filesystem (measured: readBytes gave a valid 2100-byte BMP and no
      // head was drawn). Release it, and loadHeads' repaint asks again.
      // No bytes is not the same as bad bytes: headPath answers nothing until the
      // head directory has been read, and lines painted at load ask before that.
      // Only a decode that actually had bytes to read is settled.
      if (!art) {
        if (bytes) headBad[id] = true;
        delete headPending[id];
        return;
      }
      headArt[id] = art;
      art.bmp = bmpDataUrl(bytes);
      var url = pngUrl(art);
      art.url = url || art.bmp;
      headArtPath = url ? 'canvas' : 'bmp';
      S.irc.forEach(function (e) {
        if (e.committed && e.headId === id) e._headArt = art;
      });
      renderIrc();
    }).catch(function () { delete headPending[id]; /* no art, no icon */ });
  }

  /** The raw bytes as a BMP data URL: no transparency, but it always renders. */
  function bmpDataUrl(bytes) {
    if (!bytes || !bytes.length) return null;
    var bin = '';
    for (var i = 0; i < bytes.length; i += 2048) {
      bin += String.fromCharCode.apply(null, bytes.slice(i, i + 2048));
    }
    try { return 'data:image/bmp;base64,' + btoa(bin); } catch (e) { return null; }
  }

  /**
   * The decoded pixels as a transparent PNG data URL.
   *
   * A BMP has no alpha, so a head drawn from it keeps the blue key colour as a box.
   * The platform does the encoding — a canvas rasterises the RGBA and writes the
   * PNG — but the bytes must arrive through the ImageData's own view: in Firefox a
   * content script that hands its own typed array to `putImageData` gets
   * "InvalidStateError: failed to extract Uint8ClampedArray" (or, via `.set()`,
   * "Permission denied to access object"). A pixel loop is the one form of
   * transfer both engines accept, measured on Firefox 158 and Chromium 153.
   */
  function pngUrl(art) {
    try {
      var c = document.createElement('canvas');
      c.width = art.w;
      c.height = art.h;
      var ctx = c.getContext('2d');
      var img = ctx.createImageData(art.w, art.h);
      var src = art.data, dst = img.data;
      for (var i = 0; i < src.length; i++) dst[i] = src[i];
      ctx.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    } catch (e) {
      return null;
    }
  }

  function headIcon(nick, entry, idKey) {
    idKey = idKey || 'headId';
    var id = entry && entry[idKey];
    // A settled identity (headFixed) never consults the name map again: the name
    // may already belong to somebody else, or wear a different schtick, and the
    // face the line was committed with is final.
    if (id == null && !(entry && entry.headLocked) && nick && heads[nick] != null) id = heads[nick];
    if (id == null) return null;
    var art = entry && entry._headArt || headArt[id];
    if (!art) { ensureHead(id); return null; }
    var src = art.url || art.bmp;
    return src ? el('img', { class: 'head', src: src, alt: '', 'aria-hidden': 'true' }) : null;
  }

  /* --------------------------------------------------------------- room map */

  var roomsTries = 0;

  async function loadRooms() {
    if (roomsLoading || Object.keys(rooms).length) return;
    roomsLoading = true;
    var st = await cmd('status', {});
    if (st) Object.assign(agent, st);
    var dat = agent.hasFs ? await cmd('readText', { path: '/release/sys/connect.dat' }) : null;
    roomsLoading = false;
    if (dat) {
      //   1 'FOUN' 37 '3718' 'TRAN' 'TRAN' 'STLA' 'S022' 0   // Your Room
      //   ^room  ^tileset ^other ^roomcode  ^transitions        ^the name
      // The trailing comment is the only human-readable room name in the whole
      // install, and it names the room in the FIRST column — the number the
      // player feed reports. The four-character fields are tileset and transition
      // codes, not labels, so they are no part of the name.
      dat.split(/\r?\n/).forEach(function (line) {
        var m = /^\s*(\d+)\s+'([0-9A-Za-z]{4})'\s+(\d+)\s+'([0-9A-Za-z]{4})'\s+(.*)$/.exec(line);
        if (!m) return;
        // The four-character code is the transition's kind. A TEAM record is the
        // team/nozzlebox transition, and a numeric TEAM address names the room on
        // the other side ('0501' is room 5, '1901' is 19). A room is TEAM when one
        // of those reaches it and no ordinary record does.
        var src = Number(m[1]);
        var code = m[2].toUpperCase();
        var dest = Number(m[3]);
        if (code === 'TEAM') {
          teamRow[src] = 1;
          if (/^\d{4}$/.test(m[4])) {
            var to = Number(m[4].slice(0, 2));
            if (to && to !== src) teamIn[to] = 1;
          }
        } else if (dest && dest !== src) {
          normalIn[dest] = 1;
        }
        var c = /\/\/\s*(\S.*?)\s*$/.exec(m[5]);
        if (c) rooms[src] = c[1];
      });
      relabelRooms();
    } else if (++roomsTries < 5) {
      // The filesystem is not mounted yet, or the file is not readable yet. A read
      // that said nothing is not an answer, and latching here left every move in the
      // session reading "sector 37" instead of the room's name.
      setTimeout(loadRooms, 2000);
      return;
    }
    renderChatTargets();
    syncChatLock();            // a room restored from lastRoom locks once the map is read
  }

  /** The room's real name, from the comments in connect.dat. Nothing else is one. */
  function roomLabel(n) {
    return rooms[n] || '';
  }

  /**
   * The room as a line says it: the name when the map has one, and the bare number
   * only when the number is all there is. A reader has no use for "sector 78" beside
   * "Stella Center" — it is the same room twice, and the number is a coordinate, not
   * a place. It rides in the stamp's title instead (see stampTitle).
   */
  function roomName(n) {
    return roomLabel(n) || 'sector ' + n;
  }

  /** "Central Fountain (35)" — both, for the places that have room for neither hint. */
  function roomPhrase(n) {
    var name = roomLabel(n);
    return name ? name + ' (sector ' + n + ')' : 'sector ' + n;
  }

  /**
   * A room change, written the way a reader reads it. The sector is kept on the entry
   * so the title can carry it and so a line written before connect.dat was read can be
   * renamed by relabelRooms — the name arrives a moment later and only the number is
   * known until then.
   */
  function logRoom(verb, n) {
    // The hub gets no transitions — see QUIET_ROOM. A reconnection is not a
    // transition, and it is the one thing about that room still worth a line.
    if ((verb === 'ENTERING' || verb === 'LEAVING') && quietRoom(n)) return;
    pushIrc({ t: Date.now(), kind: 'sys', verb: verb, sector: n, text: verb + ' ' + roomName(n) });
  }

  /**
   * The first login frame can beat the read of connect.dat, so the line it wrote
   * names no room. Only that shape is rewritten — a line already carrying a name is
   * settled history, and re-reading the map over it is how a move used to rewrite
   * the whole scrollback.
   */
  function relabelRooms() {
    var changed = false;
    S.irc.forEach(function (e) {
      if (e.kind !== 'sys') return;
      var verb = /^(LEAVING|ENTERING|RECONNECTED:)\s/.exec(e.text);
      if (!verb) return;
      if (e.sector == null) {
        // Written before the sector was kept on the line, so recover it from the text.
        var bare = /^[A-Z:]+\s+sector (\d+)$/.exec(e.text);
        var named = /^[A-Z:]+\s+(.+?)\s+\(sector (\d+)\)$/.exec(e.text);
        if (bare) {
          e.sector = Number(bare[1]);          // unnamed room, number in the line
        } else if (named) {
          // The old shape, "ENTERING StellaCenter (sector 78)": the coordinate is
          // recoverable, so the line is rewritten in the shape the log uses now rather
          // than left as the one thing in the scrollback that still reads differently.
          e.sector = Number(named[2]);
          e.text = verb[1] + ' ' + named[1];
          changed = true;
        } else {
          return;                              // settled history with nothing to recover
        }
      }
      var name = rooms[e.sector];
      if (!name) return;
      var want = verb[1] + ' ' + name;
      if (e.text !== want) { e.text = want; changed = true; }
    });
    if (changed) { save(); renderIrc(); }
  }

  /* ----------------------------------------------------------- /api/players */

  // Our own room, named only by a login frame. A move logs the client in to the next
  // room's server, and that frame carries the room number — captured, three moves in
  // a row (78, 1, 37) all logged in on the same socket, so a move between two rooms
  // on one server is named on the wire too. The feed is not consulted for moves: it
  // lags, so a stale room repeats across reads, and two agreeing readings used to
  // log moves that never happened — then misname the room the next real move left.
  var mySector;                 // undefined until the first login frame

  // Actor tags seen in this room. An actor can only speak or move while they are
  // in it, and every 0x00 event carries their tag, so the tags seen ARE the room.
  // Reset on every room change, because ids are handed out per room.
  var seenActors = {};

  /**
   * Who is online, read when the recipient list is about to be used.
   *
   * The dropdown is the only consumer, and the feed itself updates every 5s while
   * running a few seconds behind that, so polling it on an interval bought a value
   * that was already out of date whenever it was looked at — and kept asking for it
   * while nobody was. So it is read on the two occasions it can matter: the moment
   * the list is reached for, and a room change, which moves every "(here)" mark.
   * There is no timer left to keep in step with.
   */
  var reading = false;
  var readAt = 0;

  /** The list as it would be drawn: enough to tell whether a repaint would change it. */
  function onlineSig() {
    return players.online.map(function (p) { return p.name + ':' + p.sector; }).sort().join('|');
  }

  async function readPlayers() {
    if (reading) return;            // a burst of hovers is still one question
    reading = true;
    try {
      // Firefox resolves a relative URL in a content script against the extension
      // origin, not the page, so the feed has to be absolute here.
      var res = await fetch('https://www.castleinfinity.com/api/players', { credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var was = onlineSig();
      players.online = data.online || [];
      players.err = null;
      players.at = readAt = Date.now();
      // The read is issued as the reader reaches for the list, so their popup may be
      // open by the time the answer lands, and swapping its options out from under it
      // can dismiss it. The feed usually has nothing new to say, so the dropdown is
      // only repainted when the answer actually differs from what is already drawn.
      if (onlineSig() !== was) renderChatTargets();
    } catch (e) {
      players.err = String(e);
    } finally {
      reading = false;
    }
  }

  /**
   * Reaching for the dropdown, whether by pointer or by keyboard. Hovering reads a
   * moment before the popup opens, which is the point: the list is filled by the time
   * it is read, rather than after it has already been shown.
   *
   * An answer from the last few seconds is reused. That is not a compromise on
   * freshness — the feed itself only advances every 5s, so asking again sooner than
   * that cannot return anything newer — and it keeps a pointer crossing the field, or
   * a form tab that stops here, from turning into a request per keystroke.
   */
  var FRESH_MS = 4000;

  function wantPlayers() {
    if (Date.now() - readAt < FRESH_MS) return;
    readPlayers();
  }

  /**
   * Everything scoped to the room we are in. An actor id is handed out by the room, so
   * a name learned here belongs to somebody else in the next one, and a line is settled
   * once its room is left.
   *
   * This hangs off the room, not the socket. Captured, three moves in a row
   * (78, 1, 37) all logged in on one socket — a move between two rooms on the same
   * server opens nothing, so keying this to the socket left the last room's names in
   * the map, and the new room's roster then relabelled the lines already in the log.
   * That reads as the transcript changing under you, which is exactly what it was.
   */
  function enterRoom() {
    actorNames = {};
    actorKeys = {};
    lastLeave = {};
    heads = {};
    keyBase = 0x1e8412;
    roomGen++;
    // Ids do not survive this boundary: every line from the room we just left keeps
    // the face it already has, whatever the next room's actors are called. The head
    // is taken here, once, rather than left to the name map.
    if (freezeHeads(function (e) { return e.gen !== roomGen; })) {
      save();
      renderIrc();
    }
    seenActors = {};           // ids are per-room; the new room starts empty
    // the new room's roster has not arrived yet, and any of the old room's still
    // in flight is not news about this one
    if (presentTimer) clearTimeout(presentTimer);
    presentTimer = null;
    present = [];
    presentListed = false;
  }

  function onRoomChange() {
    flushAllSpeech();          // submits this room's open lines, then they are settled
    enterRoom();
    // Nothing is logged here: the login frame that follows on this socket names the
    // room and writes both ends of the move. A socket on its own cannot, because it
    // says only that a server was opened — reconnects and same-room sockets included.
    // It is proof of a live connection though, so a drop waiting out its grace period
    // was a move rather than an outage.
    if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
    // A move changes which players are "(here)". The feed takes a few seconds to
    // catch up with it, so the list is read now and again as it settles — one read
    // here would land on the room we just left.
    readPlayers();
    setTimeout(readPlayers, 500);
    setTimeout(readPlayers, 1500);
    setTimeout(readPlayers, 4000);
    setTimeout(readPlayers, 7000);      // reach past one feed cycle
  }

  /* ------------------------------------------------------------------- toast */

  function toast(msg) {
    var el = root.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 4000);
  }

  /* --------------------------------------------------------------------- UI */

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) n.setAttribute(k, v);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function build() {
    // Reloading the extension leaves the copy already injected into an open page
    // running, and it keeps its own panel, its own log and its own gear. Two stack,
    // the stale one ends up on top, and its gear belongs to an extension context that
    // no longer exists — so it does nothing, which looks exactly like a broken build.
    // The fresh panel takes over; the stale one goes quiet below (see current()).
    var stale = document.getElementById('c8-chat-host');
    if (stale) stale.remove();

    host = document.createElement('div');
    host.id = 'c8-chat-host';
    root = host.attachShadow({ mode: 'open' });

    // The launcher sits in the game's own top-right button row. `:host{all:initial}`
    // clears inherited custom properties, so mirror the two the row is laid out
    // with or the button drifts whenever the page changes them (safe-area insets).
    var pageStyle = getComputedStyle(document.documentElement);
    ['--top-chrome-top', '--top-chrome-right'].forEach(function (v) {
      var value = pageStyle.getPropertyValue(v);
      if (value) host.style.setProperty(v, value);
    });

    // The game listens for key events on the page and calls preventDefault(),
    // which is what stops text ever reaching an input. Our UI lives in a shadow
    // root, so the page sees event.target retargeted to the host and cannot tell
    // the keystroke came from a field — it swallows it either way.
    //
    // Stopping propagation at the shadow boundary keeps the keystroke for our
    // fields while hiding it from the game. A window-capture guard is NOT an
    // option: that fires before the event reaches our input, so typing dies
    // entirely (measured both ways against the running game).
    //
    // Navigation keys are the exception: they are the game's own controls, so they
    // are handed straight through. That is what lets you keep walking with the
    // arrows, or reveal names with PgUp, while the chat box still has focus.
    var GAME_KEYS = {
      ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Control: 1
    };
    // Home/End/Insert/PgUp/PgDn/Delete are game controls too, but handing them to
    // the page is not delivery — the WASM reads keys through its injection bridge,
    // not through events retargeted to our host — and the browser default would
    // still scroll the focused log or move the caret in the compose box. So they
    // are pressed into the game directly, as HID scancodes through the same bridge
    // that presses PgUp for names, and the panel itself never reacts to them: no
    // scrolling, no caret moves, anywhere. The codes match agent.js's NAMED table;
    // Insert (73) completes that table for the recorder too.
    var INJECT_KEYS = { Home: 74, End: 77, Insert: 73, PageUp: 75, PageDown: 78, Delete: 76 };
    ['keydown', 'keyup', 'keypress'].forEach(function (type) {
      root.addEventListener(type, function (e) {
        var sc = INJECT_KEYS[e.key];
        if (sc != null) {
          // One injected press per keydown (down+up, as the names feature does);
          // the matching keyup and keypress are only ever swallowed, so the game
          // never sees a release without a press.
          if (type === 'keydown') {
            try { cmd('press', { sc: sc }); } catch (err) { reportError('key', err); }
          }
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (!GAME_KEYS[e.key]) e.stopPropagation();
      });
    });
    var style = document.createElement('style');
    style.textContent = PANEL_CSS;
    root.appendChild(style);

    root.appendChild(el('button', {
      id: 'toggle', title: 'C8 Chat ' + buildVersion(), text: '∞',
      'aria-expanded': 'true', onclick: toggle
    }));

    root.appendChild(el('section', { id: 'panel', class: 'panel' }, [
      el('header', {
        // every part of the row that is not a button is a drag handle, so the
        // whitespace counts too — no aiming at a small icon
        onpointerdown: function (e) {
          var b = e.target && e.target.closest && e.target.closest('button');
          if (b) return;
          // A docked panel has no move drag: its outer edges are the viewport's.
          if (dockSide() !== 'float') return;
          beginDrag(e, 'move');
        }
      }, [
        el('span', { class: 'movegrip', text: '⠿', title: 'Drag to move', 'aria-hidden': 'true' }),
        el('span', { class: 'brand', text: 'C8 Chat ' + buildVersion() }),
        el('button', {
          id: 'cog', class: 'cog', title: 'Settings', 'aria-label': 'Settings',
          'aria-expanded': 'false', onclick: toggleModal
        }, [icon(ICONS.settings)]),
        el('button', { class: 'x', text: '×', title: 'Hide', onclick: toggle })
      ]),
      el('div', { id: 'content', class: 'body' }),
      el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
    ].concat(['nw', 'ne', 'sw', 'se'].map(function (c) {
      return el('div', { class: 'grip ' + c, onpointerdown: function (e) { beginDrag(e, c); } });
    })).concat([
      // The docked resize handle: the only grip that survives docking, because the
      // only edge that can move is the one facing the game. It is a focusable
      // separator so the width is reachable without a pointer; its arrow keys are
      // swallowed there, or the game would walk while the panel grows.
      el('div', {
        id: 'dock-grip', class: 'grip edge', role: 'separator', tabindex: '0',
        'aria-orientation': 'vertical', 'aria-label': 'Resize the docked panel',
        'aria-valuemin': String(MIN_W),
        title: 'Drag to resize the docked panel',
        onpointerdown: function (e) { beginDrag(e, dockSide() === 'right' ? 'w' : 'e'); },
        onkeydown: function (e) { nudgeDock(e, true); },
        onkeyup: function (e) { nudgeDock(e, false); }
      })
    ])));

    // The game's two buttons open panels in this same corner, and pressing either
    // one puts ours away — the row behaves like tabs.
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest || !t.closest('#players-btn, #help-btn')) return;
      var p = root.getElementById('panel');
      // Through the same path as the launcher, so a docked panel gives the stage
      // back the moment a game panel opens over it.
      if (p && !p.classList.contains('hidden')) setPanelHidden(true);
    }, true);

    document.documentElement.appendChild(host);
  }

  var GAME_PANELS = [['players-btn', 'players-panel'], ['help-btn', 'help-panel']];

  /** Ours covers the same corner, so close theirs on the way in rather than stack. */
  function closeGamePanels() {
    GAME_PANELS.forEach(function (pair) {
      var panel = document.getElementById(pair[1]);
      var btn = document.getElementById(pair[0]);
      if (panel && btn && getComputedStyle(panel).display !== 'none') btn.click();
    });
  }

  /* ------------------------------------------------- position, and resizing */

  // The panel is a definite box: fixed size, independent of which tab is open, so
  // switching tabs can never resize it. Until you move or resize it, it drops from
  // the button row; after that it floats at the numbers you gave it. Docked, it is
  // instead a full-height column against one side, and the game is given the rest.
  var MIN_W = 260, MIN_H = 220;
  // Default dock width matches the floating panel; the stage keeps at least this
  // much room so the game never becomes a sliver.
  var DOCK_W = 360, DOCK_MIN_STAGE = 320;

  /** 'float', 'left' or 'right' — anything else normalises to floating. */
  function dockSide() {
    return pick(PLACEMENTS, S.settings.dock);
  }

  function dockMaxW() {
    return Math.max(MIN_W, window.innerWidth - DOCK_MIN_STAGE);
  }

  function clampDockW(w) {
    w = parseInt(w, 10) || DOCK_W;
    return Math.max(MIN_W, Math.min(w, dockMaxW()));
  }

  /**
   * Keep the site's own fixed chrome inside the area the game still has.
   *
   * The canvas is fitted to #stage, but the site's login screen is a separate
   * fixed overlay centred on the viewport, and the status line and the desktop
   * key cluster are centred there too. Left alone, a docked panel covers them —
   * which is exactly what it looked like in the first pre-game screenshot. Half
   * the dock width is the distance between the viewport centre and the centre of
   * what is left, so shifting each by that much centres them in the game area.
   *
   * The login dialog is positioned by the page's own JS with inline left/top, so
   * the overlay is transformed rather than re-laid out: no fight with the page's
   * fit logic, and the canvas is never touched.
   */
  function setPageChrome(side, w) {
    var overlay = document.getElementById('login-overlay');
    var status = document.getElementById('status');
    var keys = document.getElementById('desktop-keys');
    var shift = side ? (side === 'left' ? w / 2 : -w / 2) : 0;
    var left = side
      ? (shift < 0 ? 'calc(50% - ' + (-shift) + 'px)' : 'calc(50% + ' + shift + 'px)')
      : '';
    // Both are centred by a -50% translate in the page's stylesheet, but its own
    // side-chrome layout (body.c8-side-chrome, which a desktop window gets) sets
    // transform:none. Writing left alone would then left-align them on the shifted
    // centre — half their width too far right — so the centring is restored here
    // while docked and handed back to the stylesheet when the panel floats.
    var centred = side ? 'translateX(-50%)' : '';
    if (overlay) overlay.style.transform = side ? 'translateX(' + shift + 'px)' : '';
    if (status) { status.style.left = left; status.style.transform = centred; }
    if (keys) { keys.style.left = left; keys.style.transform = centred; }

    // The game's two top-right buttons belong to the same fixed chrome, but they
    // are anchored to the viewport's right margin rather than centred, so a right
    // dock would simply sit on top of them. Nudging them by the whole docked width
    // keeps them the same distance from the stage's right edge — the width floor
    // (320px of stage) is what guarantees that lands inside it. A left dock never
    // reaches them, so nothing moves there.
    var help = document.getElementById('help-btn');
    var players = document.getElementById('players-btn');
    var nudge = side === 'right' ? 'translateX(' + (-w) + 'px)' : '';
    if (help) help.style.transform = nudge;
    if (players) players.style.transform = nudge;
  }

  /**
   * Reserve the docked width on the game's stage.
   *
   * #stage is the box the page's own c8LayoutGameCanvas() fits its 4:3 authored
   * frame into: it reads the stage rect, centres the canvas there and applies the
   * backing scale. Reserving a side of that box therefore moves AND rescales the
   * WASM screen with the aspect ratio intact, and the page's ResizeObserver on
   * #stage performs the fit live while the inner edge is dragged. The canvas
   * itself must never be touched: the page owns its left/top/width/height, and the
   * next layout would overwrite anything written there.
   *
   * Only the docked side is written; the other, plus top and bottom, stay whatever
   * the page's stylesheet computes, so the game keeps its own chrome clearances.
   */
  function setStageGutter(side, w) {
    var p = root.getElementById('panel');
    var reserve = !side || !w || (p && p.classList.contains('hidden')) ? null : side;
    setPageChrome(reserve, reserve ? w : 0);

    var stage = document.getElementById('stage');
    if (!stage) return;                    // not the game page; the panel still docks
    if (!reserve) {
      stage.style.left = '';
      stage.style.right = '';
      return;
    }
    if (reserve === 'left') {
      stage.style.left = w + 'px';
      stage.style.right = '';
    } else {
      stage.style.right = w + 'px';
      stage.style.left = '';
    }
  }

  /**
   * Ask the page to run its own canvas fit again.
   *
   * The stage observer only reports size changes, so moving the reserved space
   * from one side to the other at the same width would leave the canvas at its old
   * x. The MAIN-world agent owns that hook; this is fire-and-forget and harmless
   * if the site ever drops it.
   */
  function relayoutPage() {
    try { cmd('layout', {}, 1000); } catch (e) { /* the panel still works */ }
  }

  function applyGeometry() {
    // A panel left behind by an extension reload must not fight the live one over
    // the page's stage.
    if (!current()) return;
    var p = root.getElementById('panel');
    if (!p) return;

    S.settings.dock = dockSide();
    var side = S.settings.dock;
    p.classList.toggle('dock-left', side === 'left');
    p.classList.toggle('dock-right', side === 'right');

    if (side === 'left' || side === 'right') {
      var w = clampDockW(S.settings.dockW);
      S.settings.dockW = w;
      p.style.left = side === 'left' ? '0px' : 'auto';
      p.style.right = side === 'right' ? '0px' : 'auto';
      p.style.top = '0px';
      p.style.bottom = '0px';
      // top+bottom define the height, so the stylesheet's fixed height/max-height
      // must not win; the dock classes also drop that cap.
      p.style.height = 'auto';
      p.style.width = w + 'px';
      setStageGutter(side, w);
      var grip = root.getElementById('dock-grip');
      if (grip) {
        grip.setAttribute('aria-valuenow', String(w));
        grip.setAttribute('aria-valuemax', String(dockMaxW()));
      }
      return;
    }

    var g = S.settings.panel;
    if (g) {
      clampIntoView(g);
      p.style.left = g.x + 'px';
      p.style.top = g.y + 'px';
      p.style.right = 'auto';
      p.style.bottom = '';
      p.style.width = g.w + 'px';
      p.style.height = g.h + 'px';
    } else {
      // Never moved: hand the box back to the stylesheet's drop position.
      p.style.left = '';
      p.style.top = '';
      p.style.right = '';
      p.style.bottom = '';
      p.style.width = '';
      p.style.height = '';
    }
    setStageGutter(null, 0);
  }

  /** Keep the header — the only way to drag it back — reachable on screen. */
  function clampIntoView(g) {
    // Keep the whole panel reachable; CSS may cap its used size after a viewport
    // shrink, so clamp persisted dimensions before calculating the visible header.
    var maxW = Math.max(0, window.innerWidth - 20);
    var maxH = Math.max(0, window.innerHeight - 60);
    g.w = Math.min(Math.max(0, g.w), maxW);
    g.h = Math.min(Math.max(0, g.h), maxH);
    g.x = Math.min(Math.max(g.x, 0), Math.max(0, window.innerWidth - g.w));
    g.y = Math.min(Math.max(g.y, 0), Math.max(0, window.innerHeight - Math.min(g.h, 34)));
  }

  /** Turn the laid-out box into explicit numbers, so drag and resize share a frame. */
  function freezeGeometry() {
    var r = root.getElementById('panel').getBoundingClientRect();
    S.settings.panel = {
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height)
    };
    applyGeometry();
    return S.settings.panel;
  }

  /** Arrow keys on the docked edge handle; swallowing them keeps them from walking. */
  function nudgeDock(e, down) {
    var side = dockSide();
    if (side === 'float') return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    // A held arrow repeats keydown; keep that cheap and write the width once, on
    // the release, the way a pointer drag writes it on pointerup.
    if (!down) { save(); return; }
    var grow = side === 'left' ? e.key === 'ArrowRight' : e.key === 'ArrowLeft';
    var step = e.shiftKey ? 72 : 24;
    S.settings.dockW = clampDockW(clampDockW(S.settings.dockW) + (grow ? step : -step));
    applyGeometry();
  }

  /** `mode` is 'move' for the header grip, or an edge: 'nw', 'ne', 'sw', 'se', 'e', 'w'. */
  function beginDrag(e, mode) {
    e.preventDefault();
    var side = dockSide();

    // Docked, there is only one movable edge: the one facing the game.
    if (side !== 'float') {
      if (mode !== 'e' && mode !== 'w') return;
      var p = root.getElementById('panel');
      var startW = clampDockW(S.settings.dockW);
      var x0 = e.clientX;
      // The dock-right handle is that panel's left edge, so the same pointer delta
      // grows it in the opposite direction from the dock-left handle.
      var sign = mode === 'e' ? 1 : -1;
      function onDockMove(ev) {
        S.settings.dockW = clampDockW(startW + sign * (ev.clientX - x0));
        applyGeometry();
      }
      function onDockUp() {
        p.classList.remove('dragging');
        window.removeEventListener('pointermove', onDockMove);
        window.removeEventListener('pointerup', onDockUp);
        save();
      }
      p.classList.add('dragging');
      window.addEventListener('pointermove', onDockMove);
      window.addEventListener('pointerup', onDockUp);
      return;
    }

    var g = S.settings.panel || freezeGeometry();
    var start = { x: g.x, y: g.y, w: g.w, h: g.h };
    var x0 = e.clientX, y0 = e.clientY;
    var moving = mode === 'move';

    function onMove(ev) {
      var dx = ev.clientX - x0, dy = ev.clientY - y0;
      // work in edges, so clamping a size never drags the opposite edge with it
      var l = start.x, t = start.y, r = start.x + start.w, b = start.y + start.h;
      if (moving) {
        l += dx; r += dx; t += dy; b += dy;
      } else {
        if (mode.indexOf('w') >= 0) l += dx;
        if (mode.indexOf('e') >= 0) r += dx;
        if (mode.indexOf('n') >= 0) t += dy;
        if (mode.indexOf('s') >= 0) b += dy;
        if (r - l < MIN_W) { if (mode.indexOf('w') >= 0) l = r - MIN_W; else r = l + MIN_W; }
        if (b - t < MIN_H) { if (mode.indexOf('n') >= 0) t = b - MIN_H; else b = t + MIN_H; }
      }
      g.x = Math.round(l); g.y = Math.round(t);
      g.w = Math.round(r - l); g.h = Math.round(b - t);
      applyGeometry();
    }
    function onUp() {
      root.getElementById('panel').classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      save();
    }
    root.getElementById('panel').classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /**
   * Hide or show the panel, and let the page reclaim or give up the docked strip
   * in the same motion. Both the launcher and the game's own buttons call this.
   */
  function setPanelHidden(hidden) {
    var p = root.getElementById('panel');
    var t = root.getElementById('toggle');
    if (!p || !t) return;
    if (!hidden) closeGamePanels();
    p.classList.toggle('hidden', hidden);
    t.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    applyGeometry();
    relayoutPage();
  }

  function toggle() {
    var p = root.getElementById('panel');
    if (!p) return;
    setPanelHidden(!p.classList.contains('hidden'));
  }

  /** Clear the content area and repaint the active tab from scratch. */
  /**
   * Icons rather than words, so the title and the buttons share one row. Drawn as
   * SVG paths so they inherit `currentColor` (the active state is just a colour)
   * instead of depending on three different glyphs being in the user's fonts.
   */
  var SVGNS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    // A cog, not a sun: teeth around a ring with a hole in the middle. Rays around
    // a disc read as brightness, which is what the first attempt looked like.
    settings: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0'
      + 'l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74'
      + 'l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73'
      + 'V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73'
      + 'l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73'
      + 'l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'
      + ' M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    // Placement: a frame whose filled-looking divider marks the side the panel
    // takes, and a floating window for the movable box. One path each, because
    // icon() draws one path.
    dockLeft: 'M3 4h18v16H3z M9 4v16',
    dockRight: 'M3 4h18v16H3z M15 4v16',
    float: 'M3 5h18v14H3z M13 12h6v5h-6z',
    // A bug: a body with six legs and two antennae. Drawn on one path, like the
    // cog, because icon() only ever makes one — a workbench button, not a button.
    bug: 'm8 2 1.88 1.88 M14.12 3.88 16 2 M9 7.13v-1a3.003 3.003 0 1 1 6 0v1'
      + ' M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6'
      + ' M12 20v-9 M6.53 9C4.6 8.8 3 7.1 3 5 M6 13H2 M3 21c0-2.1 1.7-3.9 3.8-4'
      + ' M20.97 5c0 2.1-1.6 3.8-3.5 4 M22 13h-4 M17.2 17c2.1.1 3.8 1.9 3.8 4'
  };

  function icon(d, size) {
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 15));
    svg.setAttribute('height', String(size || 15));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  /**
   * Chat is the panel; Settings and Debug are a sheet laid over it, opened from the
   * cog. Keeping them out of the layout is why the panel never resizes.
   */
  var sheet = null;              // null, 'settings', or 'capture' for Debug

  function toggleModal() {
    // The cog is Settings, not "whatever sheet is up": with Debug opened from its
    // own corner button, a toggle would have closed Debug and shown the chat.
    sheet = sheet === 'settings' ? null : 'settings';
    render();
  }

  function closeSheet() {
    sheet = null;
    render();
  }

  function renderSheet(into) {
    var cog = root.getElementById('cog');
    // Both sheets hang off the cog, so both mark it as the open one.
    if (cog) cog.setAttribute('aria-expanded', sheet ? 'true' : 'false');
    if (!sheet) return;

    var body = el('div', { class: 'sheetbody' });
    into.appendChild(el('section', { class: 'sheet' }, [
      el('div', { class: 'row sheethead' }, [
        el('span', { class: 'brand', text: sheet === 'capture' ? 'Debug' : 'Settings' }),
        el('button', { class: 'x', text: '×', title: 'Close', onclick: closeSheet })
      ]),
      body,
      // Debug is a workbench for pinning down an unknown opcode, not something a
      // player sets, so it is not a row among the settings — it is a small bug in
      // the sheet's bottom-right corner. It is only here, in Settings: the chat
      // has no corner for it that is not already the scrollbar, a line of text, or
      // Send, and a debug button among the chat is a button that belongs nowhere.
      // The footer is outside the scrolling body so it never scrolls away.
      sheet === 'settings'
        ? el('div', { class: 'sheetfoot' }, [
          el('button', {
            type: 'button', id: 'bug', class: 'bug',
            title: 'Debug — every frame in and out, undecoded',
            'aria-label': 'Debug: frame capture',
            onclick: function () { sheet = 'capture'; render(); }
          }, [icon(ICONS.bug, 14)])
        ])
        : null
    ]));
    (sheet === 'capture' ? paintCapture : paintSettings)(body);
  }

  /**
   * The chat log's look, as a class and two custom properties on the panel.
   *
   * Everything the settings can change about presentation lands here and nowhere
   * else: the theme and the show/hide switches are classes, the two sizes are custom
   * properties the stylesheet reads. That is why changing any of them is one call and
   * no re-layout code — and why an unrecognised stored value can only ever fall back
   * to the default instead of leaving the log unstyled.
   *
   * The panel element is created once in build() and render() only ever clears its
   * contents, so this is safe to re-apply on every render.
   */
  function applyLook() {
    var p = root && root.getElementById('panel');
    if (!p) return;
    var s = S.settings;
    // A value this build does not know can only have come from a build that did.
    // Normalise it here, the one place that reads these for presentation, so the
    // settings sheet shows what is really in force.
    s.theme = pick(THEMES, s.theme);
    s.tsFormat = pick(TS_FMT, s.tsFormat);
    s.chatSize = clampSize(s.chatSize);
    var theme = s.theme;
    // classList, not className: the panel also carries `hidden` and `dragging`, and
    // writing the whole attribute would drop whichever of them is on.
    THEMES.forEach(function (t) { p.classList.remove('look-' + t[0]); });
    p.classList.add('look-' + theme);
    p.style.setProperty('--log-size', clampSize(s.chatSize) + 'px');
    // pick() also carries an old build's px choice (headPx 18/24/32/44) to the
    // theme default: none of those numbers is a percent this build knows.
    s.headPct = pick(HEAD_PCT, parseInt(s.headPct, 10) || 0);
    if (s.headPct) p.style.setProperty('--head-zoom', s.headPct + '%');
    else p.style.removeProperty('--head-zoom');
  }

  /**
   * The switches a line is born with. They are a snapshot on the entry, not a filter
   * over the log: turning one off must not restyle the history you were reading, and
   * turning it back on must not dress old lines in something they never wore. Only
   * the theme and the three sizes re-paint everything, because those are how the log
   * is read rather than what a line was.
   *
   * Fills only what is missing, so it doubles as the migration for lines from a build
   * that kept this in panel classes — those take the look the settings had on load,
   * which is what they were showing.
   */
  function stampLook(e) {
    var s = S.settings;
    if (e.kind === 'sys' || e.kind === 'presence') {
      if (e.hidden === undefined) e.hidden = (e.kind === 'sys' ? s.showSys : s.showPresence) === false;
      return;
    }
    if (e.heads === undefined) e.heads = s.showHeads !== false;
    if (e.nicks === undefined) e.nicks = s.showNicks !== false;
    if (e.colour === undefined) e.colour = s.nickColors !== false;
  }

  /** A failure in one section must not leave the whole panel dead. */
  function reportError(where, e) {
    var msg = String(e && e.message || e).slice(0, 120);
    if (diagErrors.length < 6) diagErrors.push(where + ': ' + msg);
    try { toast('Panel error (' + where + '): ' + msg); } catch (ignore) { /* ignore */ }
  }

  /* ------------------------------------------------------- TEAM room guard */

  /** A room whose only entrance is a TEAM entrance. */
  function teamRoom(n) {
    if (n === undefined) return false;
    if (TEAM_FALLBACK[n] === 1) return true;
    return !normalIn[n] && (teamRow[n] === 1 || teamIn[n] === 1);
  }

  function lockedHere() {
    return teamRoom(mySector) && teamAck !== mySector;
  }

  /** The hidden attribute, not the property: the panel's DOM stub only models attributes. */
  function setHidden(node, hidden) {
    if (!node) return;
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  }

  /**
   * A TEAM room hides the chat until the reader says OK. The guard belongs to the
   * room, not the pane: every render and every move re-applies it, and the log keeps
   * filling behind it so the transcript is complete when it is revealed.
   */
  function syncChatLock() {
    if (!root) return;
    var log = root.getElementById('chatlog');
    var form = root.getElementById('chatform');
    var lock = root.getElementById('chat-lock');
    if (!log || !form || !lock) return;
    var locked = lockedHere();
    setHidden(log, locked);
    setHidden(form, locked);
    setHidden(lock, !locked);
    if (!locked) return;
    // The input just vanished under the caret; put the focus on the way back in.
    var ok = root.getElementById('chat-lock-ok');
    var active = root.activeElement;
    if (ok && ok.focus && active && form.contains && form.contains(active)) ok.focus();
  }

  function acknowledgeTeam() {
    teamAck = mySector;
    syncChatLock();
    var input = root.getElementById('chat-text');
    if (input && input.focus) input.focus();
  }

  function render() {
    // Each section is guarded: a throw here used to abort the redraw, which left the
    // gear looking broken because the sheet it should open never got built.
    try { applyLook(); } catch (e) { reportError('look', e); }
    var c = root.getElementById('content');
    c.className = 'body fill';
    c.textContent = '';
    try { paintChat(); } catch (e) { reportError('chat', e); }
    try { renderSheet(c); } catch (e) { reportError('sheet', e); }
  }

  /** The chat tab. The log scrolls inside the panel, the compose row stays put. */
  function paintChat() {
    var c = root.getElementById('content');
    var pane = el('div', { class: 'chatpane' });
    c.appendChild(pane);
    // Rebuilding the pane takes the listbox with it, so nothing is open any more.
    targetsOpen = false;
    activeTarget = -1;
    pane.appendChild(el('div', {
      id: 'chatlog', class: 'chatlog',
      // only a deliberate scroll by the reader unsticks it
      onscroll: function (e) { stick = pegged(e.target); }
    }));
    pane.appendChild(el('form', {
      id: 'chatform', class: 'chatform',
      onsubmit: function (e) { e.preventDefault(); sendChat(); }
    }, [
      el('span', { id: 'chat-to-label', class: 'visually-hidden', text: 'Recipient' }),
      el('div', { id: 'chat-to-wrap' }, [
        // The recipient itself is a form value; the button and the listbox are its
        // face. A <select> is not used because an <option> holds one run of text,
        // and the room has to be dimmed and flushed right within the row.
        el('input', { type: 'hidden', id: 'chat-to', value: '' }),
        el('button', {
          type: 'button', id: 'chat-to-face',
          role: 'combobox', 'aria-haspopup': 'listbox', 'aria-expanded': 'false',
          'aria-controls': 'chat-to-list', 'aria-labelledby': 'chat-to-label',
          'aria-describedby': 'chat-to-help',
          // Reaching for this is what needs the online list, so that is when it is read
          // — on the way in (pointer or keyboard) rather than on a timer that is always
          // a few seconds behind by the time the list opens.
          onpointerenter: wantPlayers,
          onfocus: wantPlayers,
          onclick: toggleTargets,
          onkeydown: targetsKey,
          title: 'Public speech only reaches players close enough to see your speech balloon. Pick a name to message that player privately instead. The room on the right is where that player was last seen.'
        }, [
          el('span', { class: 'to-nick', id: 'chat-to-nick', text: 'Say nearby' }),
          el('span', { class: 'to-room', id: 'chat-to-room' })
        ]),
        el('div', {
          id: 'chat-to-list', role: 'listbox',
          'aria-labelledby': 'chat-to-label', hidden: true
        })
      ]),
      el('span', { id: 'chat-to-help', class: 'visually-hidden', text: 'Choose nearby public speech or a player for a private message. Each row shows the room that player was last seen in, and "here" when that is this room.' }),
      el('label', { class: 'visually-hidden', for: 'chat-text', text: 'Message' }),
      el('input', { id: 'chat-text', placeholder: 'message', autocomplete: 'off' }),
      el('button', { id: 'chat-send', type: 'submit', text: 'Send' })
    ]));
    pane.appendChild(el('div', { id: 'chat-lock', class: 'chatlock', role: 'status', hidden: true }, [
      el('p', { class: 'chatlock-msg', text: 'This might be a little cheaty in this room' }),
      el('button', {
        type: 'button', id: 'chat-lock-ok', text: "That's OK",
        onclick: acknowledgeTeam
      })
    ]));
    renderChatTargets();
    renderIrc();
    // a freshly built log starts at the top, but you want the newest line
    stick = true;
    stickToBottom(root.getElementById('chatlog'));
    syncChatLock();
  }

  /**
   * A settings row: a label and a select, wired to one setting.
   *
   * The value is assigned after the options are in: a select given a value while it
   * is still empty ignores it and falls back to the first option, which would show
   * the default while the setting said otherwise.
   */
  function selRow(label, id, value, choices, onPick) {
    var sel = el('select', { id: id }, choices.map(function (c) {
      return el('option', { value: String(c[0]), text: c[1] });
    }));
    sel.value = String(value);
    sel.addEventListener('change', function () { onPick(sel.value); });
    return el('div', { class: 'row' }, [el('label', { class: 'hint', for: id, text: label }), sel]);
  }

  function chkRow(id, label, on, onToggle) {
    var box = el('input', { type: 'checkbox', id: id, checked: on });
    box.addEventListener('change', function (e) { onToggle(e.target.checked); });
    return el('label', { class: 'hint chk' }, [box, document.createTextNode(label)]);
  }

  /** Any chat-log change: normalise, keep it, repaint the styles and the log. */
  function look() {
    applyLook();
    save();
    renderIrc();
  }

  /** The three placement buttons, marked with the one in force. */
  function syncDockButtons() {
    PLACEMENTS.forEach(function (m) {
      var b = root.getElementById('dock-' + m[0]);
      if (b) b.setAttribute('aria-pressed', dockSide() === m[0] ? 'true' : 'false');
    });
  }

  /** Placement is layout, not a look: the log is left exactly as it is. */
  function setDock(mode) {
    mode = pick(PLACEMENTS, mode);
    if (mode === dockSide()) return;
    S.settings.dock = mode;
    applyGeometry();
    relayoutPage();
    save();
    syncDockButtons();
  }

  function dockBtn(mode, label) {
    var art = mode === 'left' ? ICONS.dockLeft : mode === 'right' ? ICONS.dockRight : ICONS.float;
    return el('button', {
      type: 'button', id: 'dock-' + mode, class: 'dockbtn',
      title: label, 'aria-label': label,
      'aria-pressed': dockSide() === mode ? 'true' : 'false',
      onclick: function () { setDock(mode); }
    }, [icon(art, 16)]);
  }

  function paintSettings(c) {

    // Placement first: it changes where the whole panel lives, and the log look
    // below only changes what is inside it.
    c.appendChild(el('h4', { text: 'Panel' }));
    c.appendChild(el('div', { class: 'row dockrow', role: 'group', 'aria-label': 'Panel placement' }, [
      dockBtn('left', 'Dock left'),
      dockBtn('right', 'Dock right'),
      dockBtn('float', 'Floating')
    ]));

    c.appendChild(el('h4', { text: 'Chat log' }));

    c.appendChild(selRow('theme', 'set-theme', S.settings.theme, THEMES,
      function (v) {
        S.settings.theme = v;
        // An explicit pick settles the Default-theme move for good, so Classic can
        // be chosen again without the next load moving it back.
        S.settings.themeMoved = true;
        look();
      }));
    c.appendChild(selRow('text size', 'set-size', S.settings.chatSize,
      SIZES.map(function (n) { return [n, n + ' px']; }),
      function (v) { S.settings.chatSize = v; look(); }));
    c.appendChild(selRow('timestamp', 'set-ts', S.settings.tsFormat, TS_FMT,
      function (v) { S.settings.tsFormat = v; look(); }));
    c.appendChild(selRow('head size', 'set-headpct', pick(HEAD_PCT, parseInt(S.settings.headPct, 10) || 0), HEAD_PCT,
      function (v) { S.settings.headPct = v; look(); }));

    c.appendChild(chkRow('set-heads', 'schtick heads — the speaker\'s own face, drawn from the game art', S.settings.showHeads !== false,
      function (on) { S.settings.showHeads = on; look(); }));
    c.appendChild(chkRow('set-nicks', 'usernames', S.settings.showNicks !== false,
      function (on) { S.settings.showNicks = on; look(); }));
    c.appendChild(chkRow('set-colors', 'colour each speaker\'s name', S.settings.nickColors !== false,
      function (on) { S.settings.nickColors = on; look(); }));
    c.appendChild(chkRow('set-sys', 'room and system events', S.settings.showSys !== false,
      function (on) { S.settings.showSys = on; look(); }));
    c.appendChild(chkRow('set-presence', 'players entering and leaving the room', S.settings.showPresence !== false,
      function (on) { S.settings.showPresence = on; look(); }));
  }

  function paintCapture(c) {
    c.appendChild(el('div', { class: 'row' }, [
      el('button', {
        text: '← Settings', title: 'Back to Settings',
        onclick: function () { sheet = 'settings'; render(); }
      })
    ]));
    c.appendChild(el('div', { class: 'row' }, [
      el('button', {
        class: S.captureOn ? 'danger' : 'primary',
        text: S.captureOn ? 'Stop capture' : 'Start capture',
        onclick: function () {
          S.captureOn = !S.captureOn;
          // Raw bytes cost the page real work per frame, so the page is told when
          // to build them rather than building them and having them thrown away.
          cmd('capture', { on: S.captureOn });
          render();
        }
      }),
      el('button', { text: 'Export', onclick: exportCapture }),
      el('button', { text: 'Clear', onclick: function () { S.capture = []; renderCaptureList(); } })
    ]));
    c.appendChild(el('p', {
      class: 'hint',
      text: (S.captureOn ? 'capturing' : 'not capturing — press Start capture first') +
        ' · every frame in and out, undecoded. Export it to pin down an unknown opcode.'
    }));
    c.appendChild(el('div', { id: 'clist' }));
    renderCaptureList();
  }

  function renderCaptureList() {
    var list = root.getElementById('clist');
    if (!list) return;
    list.textContent = '';
    var win = S.capture;
    list.appendChild(el('h4', { text: win.length + ' frames' }));
    win.slice(-150).forEach(function (f) {
      list.appendChild(el('div', { class: 'frame' }, [
        el('div', { class: 'hint', text: (f.dir === 'in' ? '← ' : '→ ') + 'target ' + f.target + ' · ' + f.name + ' · ' + f.n + 'B' }),
        el('code', { text: f.hex || f.text || '' }),
        f.strings && f.strings.length ? el('div', { class: 'strs', text: f.strings.join(' | ') }) : null
      ]));
    });
  }

  function exportCapture() {
    // An empty export is useless and looks like a bug in whatever you were
    // testing, so say which of the two reasons it is instead of writing it.
    if (!S.capture.length) {
      return toast(S.captureOn
        ? 'Nothing captured yet — no frames are reaching the panel.'
        : 'Press Start capture first, then reproduce, then Export.');
    }
    var payload = {
      meta: {
        build: buildVersion(), at: Date.now(), href: location.href,
        user: agent.user || null, ready: !!agent.ready, canType: !!agent.canType,
        frames: diagFrames.n, kinds: diagFrames.kinds, types: diagFrames.types,
        outFrames: diagFrames.out, outDecoded: diagFrames.outDecoded, outKinds: diagFrames.outKinds,
        heads: Object.keys(heads).length, headArt: Object.keys(headArt).length, headArtPath: headArtPath,
        actors: diagActors, pushes: diagPushes, save: saveState,
        errors: diagErrors.slice(),
        lines: S.irc.length,
        openSpeech: speech.size,
        last: S.irc.slice(-6).map(function (e) {
          return { t: e.t, kind: e.kind, dir: e.dir, nick: e.nick, text: String(e.text || '').slice(0, 80) };
        })
      },
      frames: S.capture
    };
    var blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'c8-capture-' + Date.now() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  /* ------------------------------------------------------------------- boot */

  build();
  applyGeometry();
  // a stored position can fall outside a window that has since shrunk
  window.addEventListener('resize', applyGeometry);

  // The content_scripts "css" entry cannot reach into a shadow root, so pull the
  // stylesheet text once and inline it.
  try {
    fetch(chrome.runtime.getURL('src/panel.css'))
      .then(function (r) { return r.text(); })
      // This read lands a moment after build(), so the style element it replaces
      // is the one the build put there; the art is in panel.css with everything else.
      .then(function (t) { PANEL_CSS = t; root.querySelector('style').textContent = t; })
      .catch(function () { /* styles are cosmetic */ });
  } catch (e) { /* no extension runtime available */ }

  load();
  readPlayers();               // so the recipient list is filled before it is opened
  // The page going away ends the session, and the sockets close too late for the
  // panel to see it — so this is the last chance to say we went offline.
  window.addEventListener('pagehide', noteGone);
  cmd('status', {}).then(function (s) {
    if (!s) return;
    Object.assign(agent, s);
    // A ready event can race document_idle and be missed; the status reply is
    // therefore a second, idempotent startup path for both page-derived assets.
    loadRooms();
    loadHeads();
    render();
  });
  setInterval(function () { if (S.captureOn && sheet === 'capture') renderCaptureList(); }, 700);
})();
