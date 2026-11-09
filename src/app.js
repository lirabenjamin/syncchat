'use strict';

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { parseFields } = require('./matcher');
const { createLobby } = require('./lobby');
const reveal = require('./reveal');
const ai = require('./ai');
const { makeOriginMatcher, patternToRegexSource } = require('./origins');
const { KINDS, toCsv } = require('./storage');
const { renderDemo } = require('./demo');
const { renderGallery } = require('./gallery');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = ({ min, max }) => min + Math.random() * (max - min);

// One study's live state: its waiting room, active participants, and chat rooms.
// A room runs its condition's stages in order (a chat without `stages` is one unnamed stage).
// After a `then: qualtrics` stage the room stays reserved: both members rejoin from a later chat
// question (stage=<next id>) and the next stage starts once both are back.
// A room with an AI partner has one human member and one bot member ({ bot: true, pid: 'ai' }); the
// bot's socket is a stub whose 'message' events trigger a model call (callModel, injectable for tests).
function createStudy({ config, storage, log, callModel = ai.callModel }) {
  const { participant, limits, embed } = config;

  const lobby = createLobby(config, {
    clock: { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout },
    onMatch: startRoom,
    onTimeout: (entry, waitedMs) => {
      if (config.on_timeout === 'bot' && config.conditions[entry.cond].ai) return startAiRoom(entry, { fallback: true, waitedMs });
      recordOutcome(entry, 'nomatch', { waited_ms: waitedMs });
      entry.socket.emit('noMatch', { waited_ms: waitedMs });
      log(`[nomatch] study=${config.study.id} condition=${entry.cond}`);
    },
  });
  const active = new Map(); // participant id -> entry (waiting, chatting, or between stages)
  const finished = new Map(); // participant id -> final chatEnded payload of a staged chat, for late rejoins
  const rooms = new Set();
  const joinAllowed = rateLimiter(limits.joins_per_ip_per_minute, 60000);
  const tokensUsed = new Map(); // condition -> AI tokens spent by this server process (for budget_tokens)

  function recordOutcome(entry, outcome, extra = {}) {
    storage.record('outcomes', {
      participant_id: entry.pid, condition: entry.cond, outcome, ended_at: iso(Date.now()), ...extra,
    });
    active.delete(entry.pid);
  }

  const partnerOf = (room, m) => room.members.find((x) => x !== m);
  const humans = (room) => room.members.filter((m) => !m.bot);
  const fill = (room, m, tmpl) => (tmpl ? reveal.render(tmpl, m.fields, partnerOf(room, m).fields) : null);

  // Reveal placeholders ({partner.x}, {shared.x}) are written for dyads: "partner" is the other member.
  function startRoom({ cond: condName, members, satisfied, waived, shared, scores, prefer, at: now, bot = null }) {
    const cond = config.conditions[condName];
    const room = {
      id: crypto.randomUUID(), cond: condName, def: cond, members, messages: [], phase: 'chat', bot,
      totals: new Map(members.map((m) => [m, 0])), metAll: new Map(members.map((m) => [m, true])),
    };
    // A fallback AI partner has no fields, so the condition's reveal (written for two people) is not shown.
    const reveals = new Map(members.map((m) => [m, bot && bot.fallback ? null : fill(room, m, cond.reveal)]));
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
      waited_ms: Object.fromEntries(humans(room).map((m) => [m.pid, now - m.arrivedAt])),
      matched_at: iso(now),
      ...(bot ? {
        partner: 'ai',
        ai_fallback: bot.fallback,
        ai: {
          provider: bot.def.provider, model: bot.def.model, system_prompt: bot.system, system_prompt_file: bot.def.system_prompt_file,
          opening_message: bot.opening, vars: bot.vars,
        },
      } : {}),
    });
    rooms.add(room);
    for (const m of members) {
      m.room = room;
      m.connected = true;
    }
    beginStage(room, 0, now);
    for (const m of humans(room)) {
      m.socket.emit('matched', {
        match_id: room.id,
        ends_at: room.stage.endsAt,
        reveal: reveals.get(m),
        intro: fill(room, m, config.chat.intro),
        waited_ms: now - m.arrivedAt,
        match_reason: matchReason,
        partner_id: partnerOf(room, m).pid,
        stage: stageInfo(room, m),
      });
    }
    log(`[match] study=${config.study.id} condition=${room.cond}${bot ? ` partner=ai${bot.fallback ? ' (fallback)' : ''}` : ''} waited_ms=${humans(room).map((m) => now - m.arrivedAt).join('/')} rooms=${rooms.size}`);
    if (bot && bot.opening) postMessage(room, bot.member, bot.opening, { sender: 'ai', model: null, usage: null }); // scripted, not generated
  }

  // Pair a participant with the condition's AI partner: right away (partner: ai) or after
  // match_timeout (on_timeout: bot). Fails closed if the token budget is spent.
  function startAiRoom(entry, { fallback = false, waitedMs = 0 } = {}) {
    const def = config.conditions[entry.cond].ai;
    if (def.budget_tokens !== null && (tokensUsed.get(entry.cond) || 0) >= def.budget_tokens) return failAlone(entry, 'ai_budget_exhausted', waitedMs);
    const values = entry.promptValues;
    const member = { pid: 'ai', bot: true, cond: entry.cond, fields: {}, connected: true, arrivedAt: Date.now() };
    const bot = {
      def, fallback, member, turns: 0, busy: false, pending: false, calls: [],
      system: ai.renderPrompt(def.system_prompt, values),
      opening: def.opening_message ? ai.renderPrompt(def.opening_message, values) : null,
      vars: Object.fromEntries(def.uses.map((n) => [n, values[n]])),
    };
    member.socket = { emit: (ev, payload) => { if (ev === 'message' && !payload.mine) botHeard(member.room); }, disconnect() {} };
    startRoom({ cond: entry.cond, members: [entry, member], satisfied: [], waived: [], shared: {}, scores: [], prefer: [], at: Date.now(), bot });
  }

  // An AI chat that cannot start: the participant gets the outcome straight away.
  function failAlone(entry, outcome, waitedMs) {
    recordOutcome(entry, outcome, { waited_ms: waitedMs, partner: 'ai' });
    entry.socket.emit('chatEnded', { outcome, end_reason: outcome, message_count: 0, met_min_messages: false, waited_ms: waitedMs });
    log(`[${outcome}] study=${config.study.id} condition=${entry.cond}`);
  }

  function botHeard(room) {
    if (!room || room.ended || room.bot.turns >= room.bot.def.max_turns) return;
    room.bot.pending = true;
    if (!room.bot.busy) botTurn(room);
  }

  // One AI reply: wait out the per-participant call limit, call the model (one retry on a timeout,
  // rate limit, or server error), then post the reply no sooner than reply_delay after the message
  // that prompted it. Messages that arrive meanwhile are answered in the next turn.
  async function botTurn(room) {
    const bot = room.bot;
    const def = bot.def;
    bot.busy = true;
    bot.pending = false;
    const due = Date.now() + between(def.reply_delay_ms);
    const live = () => !room.ended && room.phase === 'chat';
    try {
      bot.calls = bot.calls.filter((t) => Date.now() - t < 60000);
      if (bot.calls.length >= def.calls_per_minute) await sleep(60000 - (Date.now() - bot.calls[0]));
      if (!live()) return;
      if (def.budget_tokens !== null && (tokensUsed.get(room.cond) || 0) >= def.budget_tokens) return failRoom(room, 'ai_budget_exhausted');
      bot.calls.push(Date.now());
      const req = { system: bot.system, messages: room.messages.slice() };
      let res;
      try {
        res = await callModel(def, req);
      } catch (e) {
        if (!e.retry || !live()) throw e;
        await sleep(1000);
        res = await callModel(def, req);
      }
      const usage = res.usage || { input_tokens: 0, output_tokens: 0 };
      tokensUsed.set(room.cond, (tokensUsed.get(room.cond) || 0) + usage.input_tokens + usage.output_tokens);
      if (!res.text) throw new Error('the model returned no text');
      await sleep(due - Date.now());
      if (!live()) return;
      postMessage(room, bot.member, res.text, { sender: 'ai', model: res.model, usage });
      bot.turns += 1;
    } catch (e) {
      log(`[ai_error] study=${config.study.id} condition=${room.cond} ${e.message}`);
      return failRoom(room, 'ai_error');
    } finally {
      bot.busy = false;
    }
    if (bot.turns >= def.max_turns) {
      // Spend cap reached: give the participant a moment to read the last reply, then end the chat.
      room.timer && clearTimeout(room.timer);
      room.timer = setTimeout(() => endStage(room, 'max_turns', null, 'completed'), Math.max(5000, def.reply_delay_ms.max));
      return;
    }
    if (bot.pending && live()) botTurn(room);
  }

  function failRoom(room, outcome) {
    endStage(room, outcome, null, outcome);
  }

  // What the chat page needs to show the current stage to member m.
  function stageInfo(room, m) {
    const { def, startedAt, endsAt, capAt, counts, done } = room.stage;
    return {
      id: def.id,
      index: room.stageIndex,
      count: room.def.stages.length,
      prompt: fill(room, m, def.prompt),
      reveal: fill(room, m, def.reveal),
      started_at: startedAt,
      ends_at: endsAt,
      max_ends_at: capAt,
      min_messages: def.min_messages,
      end_when: def.end_when,
      my_count: counts.get(m),
      done: done.has(m),
      partner_done: done.has(partnerOf(room, m)),
    };
  }

  // The whole room as member m sees it: sent on a reconnect and when a stage starts after a rejoin.
  function chatState(room, m) {
    return {
      match_id: room.id,
      partner_id: partnerOf(room, m).pid,
      intro: fill(room, m, config.chat.intro),
      stage: stageInfo(room, m),
      transcript: room.messages.map((x) => ({ mine: x.from === m, text: x.text, ts: x.ts, stage_index: x.stageIndex })),
      partner_away: !partnerOf(room, m).connected,
    };
  }

  function beginStage(room, index, now) {
    const def = room.def.stages[index];
    const untimed = def.chat_duration_ms === null;
    room.stageIndex = index;
    room.phase = 'chat';
    room.stage = {
      def, startedAt: now, endsAt: untimed ? null : now + def.chat_duration_ms, capAt: untimed ? now + def.max_duration_ms : null,
      counts: new Map(room.members.map((m) => [m, 0])), done: new Set(), extended: false,
    };
    armTimer(room, (room.stage.endsAt ?? room.stage.capAt) - now);
  }

  function armTimer(room, ms) {
    clearTimeout(room.timer);
    room.timer = setTimeout(() => stageTimeUp(room), ms);
  }

  // Timer (or max_duration cap) reached. A timed stage with extend_until_min runs on once, until
  // everyone has sent min_messages or the extension runs out.
  function stageTimeUp(room) {
    const s = room.stage;
    if (s.endsAt === null) return endStage(room, 'max_duration');
    const short = humans(room).some((m) => s.counts.get(m) < s.def.min_messages);
    if (s.extended || !short || !s.def.extend_until_min_ms) return endStage(room, 'timer');
    s.extended = true;
    s.endsAt = Date.now() + s.def.extend_until_min_ms;
    armTimer(room, s.def.extend_until_min_ms);
    for (const m of humans(room)) m.socket.emit('stageExtended', { ends_at: s.endsAt, min_messages: s.def.min_messages });
  }

  function stageEndPayload(room, m) {
    const s = room.stage;
    return {
      match_id: room.id,
      stage: s.def.id,
      next_stage: room.def.stages[room.stageIndex + 1].id,
      stage_index: room.stageIndex,
      end_reason: s.reason,
      message_count: s.counts.get(m),
      met_min_messages: s.counts.get(m) >= s.def.min_messages,
    };
  }

  // reason: timer, max_duration, min_reached, both_done, either_done, or left (with the leaver).
  // last: end the whole chat whatever stage it is in, with this outcome (an AI partner's max_turns or failure).
  function endStage(room, reason, leaver = null, last = null) {
    if (room.ended || room.phase !== 'chat') return;
    clearTimeout(room.timer);
    const s = room.stage;
    const now = Date.now();
    s.reason = reason;
    for (const m of room.members) {
      room.totals.set(m, room.totals.get(m) + s.counts.get(m));
      if (s.counts.get(m) < s.def.min_messages) room.metAll.set(m, false);
    }
    const perMember = (f) => Object.fromEntries(room.members.map((m) => [m.pid, f(m)]));
    if (room.def.staged) storage.record('stages', {
      match_id: room.id,
      condition: room.cond,
      stage: s.def.id,
      stage_index: room.stageIndex,
      started_at: iso(s.startedAt),
      ended_at: iso(now),
      end_reason: reason,
      message_counts: perMember((m) => s.counts.get(m)),
      met_min_messages: perMember((m) => s.counts.get(m) >= s.def.min_messages),
      clicked_done: room.members.filter((m) => s.done.has(m)).map((m) => m.pid),
    });
    if (reason === 'left') return finishRoom(room, reason, (m) => (m === leaver ? 'left' : 'partner_left'), leaver);
    if (!s.def.then || last) return finishRoom(room, reason, () => last || 'completed');
    if (s.def.then === 'continue') {
      beginStage(room, room.stageIndex + 1, now);
      for (const m of humans(room)) m.socket.emit('stageStarted', stageInfo(room, m));
      return;
    }
    // then: qualtrics. The survey moves on; each member rejoins with stage=<next id>.
    room.phase = 'between';
    room.betweenSince = now;
    for (const m of room.members) {
      m.ready = false;
      clearTimeout(m.graceTimer);
      m.socket.emit('stageEnded', stageEndPayload(room, m));
    }
    room.rejoinTimer = setTimeout(() => finishRoom(room, 'no_rejoin', (m) => (m.ready ? 'partner_left' : 'no_rejoin')),
      room.def.timing.rejoin_timeout_ms);
  }

  function finishRoom(room, endReason, outcomeOf, leaver = null) {
    if (room.ended) return;
    room.ended = true;
    room.phase = 'ended';
    clearTimeout(room.timer);
    clearTimeout(room.rejoinTimer);
    rooms.delete(room);
    const staged = room.def.staged;
    for (const m of humans(room)) {
      clearTimeout(m.graceTimer);
      const outcome = outcomeOf(m);
      const extra = {
        match_id: room.id, message_count: room.totals.get(m) ?? 0, met_min_messages: room.metAll.get(m), end_reason: endReason,
        ...(room.bot ? { partner: 'ai' } : {}),
        ...(staged ? {
          stage: room.stage.def.id,
          stage_message_count: room.stage.counts.get(m),
          stage_met_min_messages: room.stage.counts.get(m) >= room.stage.def.min_messages,
        } : {}),
      };
      recordOutcome(m, outcome, extra);
      const payload = {
        outcome, ...extra,
        transcript: embed.send_transcript_to_parent
          ? room.messages.map((x) => ({ mine: x.from === m, text: x.text, ts: x.ts, ...(staged ? { stage: x.stage } : {}) }))
          : undefined,
      };
      if (staged) finished.set(m.pid, payload);
      if (m !== leaver) m.socket.emit('chatEnded', payload);
    }
    log(`[end] study=${config.study.id} condition=${room.cond}${room.bot ? ' partner=ai' : ''} outcome=${endReason} messages=${room.messages.length}`);
  }

  function join(socket, ip, params) {
    const fail = (code, message) => socket.emit('joinError', { code, message });
    if (!joinAllowed(ip)) return fail('rate_limited', 'Too many attempts. Please wait a minute.');

    const pid = String(params[participant.id_param] ?? '').trim().slice(0, 128);
    if (!pid) return fail('missing_id', `Missing participant ID (URL parameter "${participant.id_param}").`);
    if (finished.has(pid)) return socket.emit('chatEnded', finished.get(pid));
    const reserved = active.get(pid);
    if (reserved && reserved.room && reserved.room.def.staged) return rejoin(socket, reserved, params, fail);

    const condNames = Object.keys(config.conditions);
    const cond = params[participant.condition_param] ?? (condNames.length === 1 ? condNames[0] : undefined);
    if (!Object.hasOwn(config.conditions, cond)) {
      return fail('unknown_condition', `Unknown condition (URL parameter "${participant.condition_param}").`);
    }
    const { staged, stages, timing } = config.conditions[cond];
    if (staged && params.stage !== undefined && String(params.stage) !== stages[0].id) {
      return stages.some((s) => s.id === String(params.stage))
        ? fail('no_pair', 'There is no conversation to return to.')
        : fail('unknown_stage', 'Unknown stage (URL parameter "stage").');
    }
    let fields;
    try {
      fields = parseFields(params, participant.fields);
    } catch (e) {
      return fail('invalid_field', e.message);
    }
    if (active.has(pid)) return fail('duplicate_id', 'This participant ID is already connected.');
    const aiDef = config.conditions[cond].ai;
    let prompt = null;
    if (aiDef) {
      prompt = ai.promptValues(aiDef, params, fields);
      if (prompt.missing.length && aiDef.missing_vars === 'error') {
        return fail('missing_var', `Missing information for the chat (URL parameter${prompt.missing.length > 1 ? 's' : ''} ${prompt.missing.map((n) => `"${n}"`).join(', ')}).`);
      }
    }

    const now = Date.now();
    const entry = { pid, cond, fields, socket, study: api, promptValues: prompt && prompt.values };
    socket.data.entry = entry;
    active.set(pid, entry);
    storage.record('arrivals', {
      participant_id: pid, condition: cond, fields, arrived_at: iso(now),
      ...(prompt ? { prompt_vars: Object.fromEntries(Object.keys(aiDef.vars).map((n) => [n, prompt.values[n]])) } : {}),
    });
    if (config.conditions[cond].partner === 'ai') {
      entry.arrivedAt = now;
      return startAiRoom(entry);
    }
    socket.emit('waiting', { timeout_at: now + timing.match_timeout_ms });
    lobby.join(entry);
  }

  // A member of a staged room connects again: a reload mid-stage, a reload of the page after a
  // `then: qualtrics` stage ended, or the later chat question (stage=<next id>).
  function rejoin(socket, entry, params, fail) {
    const room = entry.room;
    const { stages } = room.def;
    const want = params.stage === undefined ? 0 : stages.findIndex((s) => s.id === String(params.stage));
    if (want < 0) return fail('unknown_stage', 'Unknown stage (URL parameter "stage").');
    // The chat question for stage `want` also shows the stages that follow it by `then: continue`.
    const covers = (i) => i >= want && stages.slice(want, i).every((s) => s.then === 'continue');
    const next = room.phase === 'between' && want === room.stageIndex + 1;
    if (!next && !covers(room.stageIndex)) return fail('wrong_stage', 'This part of the conversation is not available right now.');

    const old = entry.socket;
    if (old !== socket) {
      old.data.entry = null;
      old.disconnect(true);
    }
    entry.socket = socket;
    entry.connected = true;
    socket.data.entry = entry;
    const partner = partnerOf(room, entry);

    if (room.phase === 'chat') {
      clearTimeout(entry.graceTimer);
      socket.emit('chatState', chatState(room, entry));
      return partner.socket.emit('partnerBack');
    }
    if (!next) return socket.emit('stageEnded', stageEndPayload(room, entry)); // reload before the survey moved on
    entry.ready = true;
    if (!partner.ready) return socket.emit('waitingPartner', { timeout_at: room.betweenSince + room.def.timing.rejoin_timeout_ms });
    clearTimeout(room.rejoinTimer);
    beginStage(room, room.stageIndex + 1, Date.now());
    for (const m of room.members) m.socket.emit('chatState', chatState(room, m));
  }

  function message(entry, text) {
    const room = entry.room;
    if (!room || room.phase !== 'chat') return;
    if (!entry.socket.data.msgAllowed(entry.pid)) return entry.socket.emit('rateLimited');
    const clean = String(text ?? '').trim().slice(0, limits.max_message_length);
    if (!clean) return;
    postMessage(room, entry, clean, room.bot ? { sender: 'participant' } : {});
  }

  // Store and relay one message. extra: in a room with an AI partner, sender (participant or ai),
  // plus the model id and token usage for AI messages.
  function postMessage(room, from, text, extra) {
    const s = room.stage;
    const msg = { from, text, ts: Date.now(), stage: s.def.id, stageIndex: room.stageIndex };
    room.messages.push(msg);
    s.counts.set(from, s.counts.get(from) + 1);
    storage.record('messages', {
      match_id: room.id, participant_id: from.pid, seq: room.messages.length, text, ts: iso(msg.ts),
      ...(room.def.staged ? { stage: s.def.id } : {}), ...extra,
    });
    for (const m of room.members) m.socket.emit('message', { mine: m === from, text, ts: msg.ts });
    if (s.extended && humans(room).every((m) => s.counts.get(m) >= s.def.min_messages)) endStage(room, 'min_reached');
  }

  // The Done button. Enforced here: only with end_when both_done/either_done, and only after min_messages.
  function done(entry) {
    const room = entry.room;
    if (!room || room.phase !== 'chat') return;
    const s = room.stage;
    if (s.def.end_when === 'timer' || s.done.has(entry)) return;
    const sent = s.counts.get(entry);
    if (sent < s.def.min_messages) return entry.socket.emit('doneRejected', { sent, min_messages: s.def.min_messages });
    s.done.add(entry);
    if (s.def.end_when === 'either_done' || humans(room).every((m) => s.done.has(m))) return endStage(room, s.def.end_when);
    for (const m of humans(room)) m.socket.emit('doneUpdate', { done: s.done.has(m), partner_done: s.done.has(partnerOf(room, m)) });
  }

  function disconnect(entry, socket) {
    if (active.get(entry.pid) !== entry || entry.socket !== socket) return;
    const room = entry.room;
    if (!room) {
      lobby.leave(entry);
      return recordOutcome(entry, 'left_waiting', { waited_ms: Date.now() - entry.arrivedAt });
    }
    entry.connected = false;
    if (room.phase === 'between') {
      entry.ready = false;
      return;
    }
    if (!room.def.staged) return endStage(room, 'left', entry);
    // In a staged chat a reload or dropped connection may come back within rejoin_timeout.
    const graceMs = room.def.timing.rejoin_timeout_ms;
    partnerOf(room, entry).socket.emit('partnerAway', { grace_ms: graceMs });
    entry.graceTimer = setTimeout(() => endStage(room, 'left', entry), graceMs);
  }

  const api = {
    config,
    storage,
    join,
    message,
    done,
    disconnect,
    status: () => ({ waiting: lobby.counts(), rooms: rooms.size }),
    clientConfig: () => ({
      id_param: participant.id_param,
      condition_param: participant.condition_param,
      max_message_length: limits.max_message_length,
      parent_origin_patterns: embed.allowed_origins.map(patternToRegexSource),
      redirect_url: embed.redirect_url,
    }),
    close() {
      for (const room of rooms) {
        clearTimeout(room.timer);
        clearTimeout(room.rejoinTimer);
        for (const m of room.members) clearTimeout(m.graceTimer);
      }
      lobby.clear();
    },
  };
  return api;
}

// Single-study mode: createApp({ config, storage }). Multi-study mode: createApp({ studies: [{ config,
// storage, source }] }); each study has its own lobby and storage, chosen by the `study` URL parameter,
// and `/` lists them in a gallery. `source` is the raw YAML shown in the gallery.
// callModel: replaces the real model call (tests inject a fake one).
function createApp({ config, storage, studies, log = console.log, callModel }) {
  const multi = Array.isArray(studies);
  const list = (multi ? studies : [{ config, storage }]).map((s) => ({ ...createStudy({ ...s, log, callModel }), source: s.source }));
  const byId = new Map(list.map((s) => [s.config.study.id, s]));
  // In single-study mode the `study` parameter is ignored, so v0.1 URLs keep working.
  const pick = (id) => (multi ? byId.get(String(id ?? '')) : list[0]);
  const origins = [...new Set(list.flatMap((s) => s.config.embed.allowed_origins))];
  const originAllowed = makeOriginMatcher(origins);

  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);

  // Only allowed origins may frame the page.
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${origins.join(' ')}`);
    next();
  });
  // The bare URL (no participant params) is the gallery (multi) or the demo form (single);
  // with params it is the chat page.
  const galleryHtml = multi ? renderGallery(list) : null;
  const showGallery = (req, res) => (multi ? res.type('html').send(galleryHtml) : res.redirect('/demo'));
  app.get('/', (req, res, next) => (Object.keys(req.query).length ? next() : showGallery(req, res)));
  app.get('/gallery', showGallery);
  const demoHtml = new Map(list.map((s) => [s, renderDemo(s.config, { study: multi ? s.config.study.id : null })]));
  app.get('/demo', (req, res) => {
    const s = pick(req.query.study);
    return s ? res.type('html').send(demoHtml.get(s)) : res.redirect('/gallery');
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/client-config.json', (req, res) => {
    const s = pick(req.query.study);
    return s ? res.json(s.clientConfig()) : res.status(404).json({ error: 'unknown study' });
  });

  app.get('/healthz', (req, res) => {
    const base = { ok: true, storage: list[0].storage.backend };
    if (!multi) return res.json({ ...base, study: list[0].config.study.id, ...list[0].status() });
    res.json({ ...base, studies: Object.fromEntries(list.map((s) => [s.config.study.id, s.status()])) });
  });

  app.get('/export', async (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    const given = String(req.query.token || '');
    const ok = token && given.length === token.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!ok) return res.status(403).json({ error: 'forbidden' });
    const s = pick(req.query.study);
    if (!s) return res.status(400).json({ error: `study must be one of ${[...byId.keys()].join(', ')}` });
    const data = await s.storage.exportAll();
    if (req.query.format !== 'csv') return res.json(data);
    const table = req.query.table || 'matches';
    if (!KINDS.includes(table)) return res.status(400).json({ error: `table must be one of ${KINDS.join(', ')}` });
    res.type('text/csv').attachment(`${s.config.study.id}_${table}.csv`).send(toCsv(data[table]));
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

  io.on('connection', (socket) => {
    const fwd = String(socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || socket.handshake.address;
    socket.on('join', (params) => {
      if (socket.data.entry) return;
      if (!params || typeof params !== 'object') {
        return socket.emit('joinError', { code: 'bad_request', message: 'Missing parameters.' });
      }
      const s = pick(params.study);
      if (!s) return socket.emit('joinError', { code: 'unknown_study', message: 'Unknown study (URL parameter "study").' });
      socket.data.msgAllowed = rateLimiter(s.config.limits.messages_per_10s, 10000);
      s.join(socket, ip, params);
    });
    socket.on('message', (text) => socket.data.entry && socket.data.entry.study.message(socket.data.entry, text));
    socket.on('done', () => socket.data.entry && socket.data.entry.study.done(socket.data.entry));
    socket.on('disconnect', () => socket.data.entry && socket.data.entry.study.disconnect(socket.data.entry, socket));
  });

  return {
    server,
    listen: (port) => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      for (const s of list) s.close();
      io.close(() => resolve());
    }),
  };
}

module.exports = { createApp };
