'use strict';

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { parseFields } = require('./matcher');
const { createLobby } = require('./lobby');
const reveal = require('./reveal');
const { makeOriginMatcher, patternToRegexSource } = require('./origins');
const { KINDS, toCsv } = require('./storage');
const { renderDemo } = require('./demo');

const iso = (ms) => new Date(ms).toISOString();

// Sliding-window counter: allow(key) is false once `max` hits land within `windowMs`.
function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

function createApp({ config, storage, log = console.log }) {
  const { participant, timing, limits, embed } = config;
  const originAllowed = makeOriginMatcher(embed.allowed_origins);

  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);

  // Only allowed origins may frame the page.
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${embed.allowed_origins.join(' ')}`);
    next();
  });
  // The bare URL (no participant params) goes to the demo form; with params it is the chat page.
  app.get('/', (req, res, next) => (Object.keys(req.query).length ? next() : res.redirect('/demo')));
  const demoHtml = renderDemo(config);
  app.get('/demo', (req, res) => res.type('html').send(demoHtml));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/client-config.json', (req, res) => {
    res.json({
      id_param: participant.id_param,
      condition_param: participant.condition_param,
      max_message_length: limits.max_message_length,
      parent_origin_patterns: embed.allowed_origins.map(patternToRegexSource),
      redirect_url: embed.redirect_url,
    });
  });

  // ---- live state ----
  const lobby = createLobby(config, {
    clock: { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout },
    onMatch: startRoom,
    onTimeout: (entry, waitedMs) => {
      recordOutcome(entry, 'nomatch', { waited_ms: waitedMs });
      entry.socket.emit('noMatch', { waited_ms: waitedMs });
      log(`[nomatch] condition=${entry.cond}`);
    },
  });
  const active = new Map(); // participant id -> entry (waiting or chatting)
  const rooms = new Set();

  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      study: config.study.id,
      storage: storage.backend,
      waiting: lobby.counts(),
      rooms: rooms.size,
    });
  });

  app.get('/export', async (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    const given = String(req.query.token || '');
    const ok = token && given.length === token.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!ok) return res.status(403).json({ error: 'forbidden' });
    const data = await storage.exportAll();
    if (req.query.format !== 'csv') return res.json(data);
    const table = req.query.table || 'matches';
    if (!KINDS.includes(table)) return res.status(400).json({ error: `table must be one of ${KINDS.join(', ')}` });
    res.type('text/csv').attachment(`${config.study.id}_${table}.csv`).send(toCsv(data[table]));
  });

  const io = new Server(server, {
    maxHttpBufferSize: 1e5,
    // Browsers send Origin; accept our own page and the allowed embedders. Non-browser
    // clients (no Origin) are allowed so the server can be scripted and tested.
    allowRequest: (req, cb) => {
      const o = req.headers.origin;
      let self = false;
      try { self = !!o && new URL(o).host === req.headers.host; } catch { /* malformed origin */ }
      cb(null, !o || self || originAllowed(o));
    },
  });

  const joinAllowed = rateLimiter(limits.joins_per_ip_per_minute, 60000);

  function recordOutcome(entry, outcome, extra = {}) {
    storage.record('outcomes', {
      participant_id: entry.pid, condition: entry.cond, outcome, ended_at: iso(Date.now()), ...extra,
    });
    active.delete(entry.pid);
  }

  // Reveal placeholders ({partner.x}, {shared.x}) are written for dyads: "partner" is the other member.
  function startRoom({ cond: condName, members, satisfied, waived, shared, scores, prefer, at: now }) {
    const cond = config.conditions[condName];
    const room = {
      id: crypto.randomUUID(), cond: condName, members, startedAt: now,
      endsAt: now + timing.chat_duration_ms, counts: new Map(members.map((m) => [m, 0])), messages: [],
    };
    const others = (m) => members.filter((x) => x !== m);
    const reveals = new Map(members.map((m) => [m, cond.reveal ? reveal.render(cond.reveal, m.fields, others(m)[0].fields) : null]));
    const matchReason = [...satisfied, ...waived.map((w) => `waived ${w}`)].join('; ');
    storage.record('matches', {
      match_id: room.id,
      condition: room.cond,
      participant_ids: members.map((m) => m.pid),
      rules_satisfied: satisfied,
      rules_waived: waived,
      shared,
      prefer_rules: prefer,
      scores,
      reveal: Object.fromEntries(members.map((m) => [m.pid, reveals.get(m)])),
      waited_ms: Object.fromEntries(members.map((m) => [m.pid, now - m.arrivedAt])),
      matched_at: iso(now),
    });
    room.timer = setTimeout(() => endRoom(room, 'completed'), timing.chat_duration_ms);
    rooms.add(room);
    for (const m of members) {
      m.room = room;
      m.socket.emit('matched', {
        match_id: room.id,
        ends_at: room.endsAt,
        reveal: reveals.get(m),
        intro: config.chat.intro ? reveal.render(config.chat.intro, m.fields, others(m)[0].fields) : null,
        waited_ms: now - m.arrivedAt,
        match_reason: matchReason,
        partner_id: others(m).map((x) => x.pid).join(','),
      });
    }
    log(`[match] condition=${room.cond} waited_ms=${members.map((m) => now - m.arrivedAt).join('/')} rooms=${rooms.size}`);
  }

  function endRoom(room, reason, leaver = null) {
    if (room.ended) return;
    room.ended = true;
    clearTimeout(room.timer);
    rooms.delete(room);
    for (const m of room.members) {
      const outcome = reason === 'completed' ? 'completed' : m === leaver ? 'left' : 'partner_left';
      const count = room.counts.get(m);
      const metMin = count >= timing.min_messages;
      recordOutcome(m, outcome, { match_id: room.id, message_count: count, met_min_messages: metMin });
      if (m !== leaver) {
        m.socket.emit('chatEnded', {
          outcome, match_id: room.id, message_count: count, met_min_messages: metMin,
          transcript: embed.send_transcript_to_parent
            ? room.messages.map((x) => ({ mine: x.from === m, text: x.text, ts: x.ts }))
            : undefined,
        });
      }
    }
    log(`[end] condition=${room.cond} outcome=${reason} messages=${room.messages.length}`);
  }

  function handleJoin(socket, ip, params) {
    if (socket.data.entry) return;
    const fail = (code, message) => socket.emit('joinError', { code, message });
    if (!joinAllowed(ip)) return fail('rate_limited', 'Too many attempts. Please wait a minute.');
    if (!params || typeof params !== 'object') return fail('bad_request', 'Missing parameters.');

    const pid = String(params[participant.id_param] ?? '').trim().slice(0, 128);
    if (!pid) return fail('missing_id', `Missing participant ID (URL parameter "${participant.id_param}").`);
    const condNames = Object.keys(config.conditions);
    const cond = params[participant.condition_param] ?? (condNames.length === 1 ? condNames[0] : undefined);
    if (!Object.hasOwn(config.conditions, cond)) {
      return fail('unknown_condition', `Unknown condition (URL parameter "${participant.condition_param}").`);
    }
    let fields;
    try {
      fields = parseFields(params, participant.fields);
    } catch (e) {
      return fail('invalid_field', e.message);
    }
    if (active.has(pid)) return fail('duplicate_id', 'This participant ID is already connected.');

    const now = Date.now();
    const entry = { pid, cond, fields, socket };
    socket.data.entry = entry;
    active.set(pid, entry);
    storage.record('arrivals', { participant_id: pid, condition: cond, fields, arrived_at: iso(now) });
    socket.emit('waiting', { timeout_at: now + timing.match_timeout_ms });
    lobby.join(entry);
  }

  function handleMessage(socket, text) {
    const entry = socket.data.entry;
    const room = entry && entry.room;
    if (!room || room.ended) return;
    if (!socket.data.msgAllowed(entry.pid)) return socket.emit('rateLimited');
    const clean = String(text ?? '').trim().slice(0, limits.max_message_length);
    if (!clean) return;
    const msg = { from: entry, text: clean, ts: Date.now() };
    room.messages.push(msg);
    room.counts.set(entry, room.counts.get(entry) + 1);
    storage.record('messages', {
      match_id: room.id, participant_id: entry.pid, seq: room.messages.length, text: clean, ts: iso(msg.ts),
    });
    for (const m of room.members) m.socket.emit('message', { mine: m === entry, text: clean, ts: msg.ts });
  }

  function handleDisconnect(socket) {
    const entry = socket.data.entry;
    if (!entry || !active.has(entry.pid) || active.get(entry.pid) !== entry) return;
    if (entry.room) endRoom(entry.room, 'left', entry);
    else {
      lobby.leave(entry);
      recordOutcome(entry, 'left_waiting', { waited_ms: Date.now() - entry.arrivedAt });
    }
  }

  io.on('connection', (socket) => {
    const fwd = String(socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || socket.handshake.address;
    socket.data.msgAllowed = rateLimiter(limits.messages_per_10s, 10000);
    socket.on('join', (params) => handleJoin(socket, ip, params));
    socket.on('message', (text) => handleMessage(socket, text));
    socket.on('disconnect', () => handleDisconnect(socket));
  });

  return {
    server,
    listen: (port) => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      for (const room of rooms) clearTimeout(room.timer);
      lobby.clear();
      io.close(() => resolve());
    }),
  };
}

module.exports = { createApp };
