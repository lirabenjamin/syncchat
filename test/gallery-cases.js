'use strict';
// Shared by test/gallery.test.js (local server) and test/live.test.js (deployed gallery); has no tests itself.
const { io: connect } = require('socket.io-client');

// For each gallery study: two compatible participants and the reveal each one sees.
const matches = [
  { study: 'shared-interest', a: { top3: 'jazz,hiking,coffee' }, b: { top3: 'jazz,soccer,movies' },
    reveal: ['You were matched because you both picked jazz.', 'You were matched because you both picked jazz.'] },
  { study: 'cross-party', a: { party: 'Democrat' }, b: { party: 'Republican' },
    reveal: ['Your partner is a Republican.', 'Your partner is a Democrat.'] },
  { study: 'same-vs-cross', a: { cond: 'same', party: 'Republican' }, b: { cond: 'same', party: 'Republican' },
    reveal: ['Your partner is also a Republican.', 'Your partner is also a Republican.'] },
  { study: 'opposing-views', a: { stance: '2' }, b: { stance: '6' },
    reveal: ['You were matched because you disagree: you said 2, they said 6.',
      'You were matched because you disagree: you said 6, they said 2.'] },
  { study: 'similar-age-relax', a: { age: '30' }, b: { age: '36' },
    reveal: ['You were paired by age: you are 30 and your partner is 36.', 'You were paired by age: you are 36 and your partner is 30.'] },
  { study: 'advice-pairs', a: { role: 'Seeking advice', topic: 'career' }, b: { role: 'Giving advice', topic: 'career' },
    reveal: ["You're paired to talk about career: one of you is seeking advice, the other giving it.",
      "You're paired to talk about career: one of you is seeking advice, the other giving it."] },
  { study: 'combo', a: { party: 'Democrat', gender: 'Woman', age: '40', interests: 'jazz,travel' },
    b: { party: 'Republican', gender: 'Man', age: '62', interests: 'travel,soccer' },
    reveal: ['Your partner is a Republican, a Man aged 62.', 'Your partner is a Democrat, a Woman aged 40.'] },
];

// Pairs that must NOT match: both wait.
const nonMatches = [
  { study: 'opposing-views', a: { stance: '3' }, b: { stance: '4' } },
  { study: 'advice-pairs', a: { role: 'Seeking advice', topic: 'money' }, b: { role: 'Seeking advice', topic: 'money' } },
];

// Connect a participant to `url`; next(event) resolves with that event's next payload.
function join(url, params, { origin } = {}) {
  const socket = connect(url, { forceNew: true, extraHeaders: origin ? { origin } : {} });
  const queues = {};
  for (const ev of ['waiting', 'matched', 'noMatch', 'joinError', 'message', 'chatEnded', 'stageEnded', 'chatState', 'waitingPartner', 'doneUpdate']) {
    queues[ev] = [];
    socket.on(ev, (p) => queues[ev].push(p));
  }
  socket.on('connect', () => socket.emit('join', params));
  const next = (ev, ms = 20000) => new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (queues[ev].length) return resolve(queues[ev].shift());
      if (Date.now() - start > ms) return reject(new Error(`timed out waiting for ${ev}`));
      setTimeout(poll, 10);
    })();
  });
  return { socket, next, seen: (ev) => queues[ev].length };
}

module.exports = { matches, nonMatches, join };
