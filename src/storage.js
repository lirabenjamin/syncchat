'use strict';

const fs = require('fs');
const path = require('path');

// Four record kinds, one JSONL file (or Mongo collection) each.
const KINDS = ['arrivals', 'matches', 'messages', 'outcomes'];

function createJsonlStorage(dir, studyId) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (kind) => path.join(dir, `${kind}.jsonl`);
  return {
    backend: 'jsonl',
    record(kind, doc) {
      fs.appendFileSync(file(kind), JSON.stringify({ study_id: studyId, ...doc }) + '\n');
    },
    async exportAll() {
      const out = {};
      for (const kind of KINDS) {
        const f = file(kind);
        out[kind] = fs.existsSync(f)
          ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
              .filter((r) => r.study_id === studyId)
          : [];
      }
      return out;
    },
    async close() {},
  };
}

async function createMongoStorage(uri, studyId, log) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(); // database named in the URI
  return {
    backend: 'mongo',
    record(kind, doc) {
      db.collection(kind)
        .insertOne({ study_id: studyId, ...doc })
        .catch((e) => log(`[storage] mongo insert into ${kind} failed: ${e.message}`));
    },
    async exportAll() {
      const out = {};
      for (const kind of KINDS) {
        out[kind] = await db.collection(kind).find({ study_id: studyId }, { projection: { _id: 0 } }).toArray();
      }
      return out;
    },
    close: () => client.close(),
  };
}

function createStorage({ mongoUri, dataDir, studyId, log = console.log }) {
  if (mongoUri) return createMongoStorage(mongoUri, studyId, log);
  return Promise.resolve(createJsonlStorage(dataDir, studyId));
}

function toCsv(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === undefined || v === null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

module.exports = { KINDS, createStorage, toCsv };
