'use strict';

const crypto = require('crypto');

const BASE = String(process.env.AI_PREVIEW_SERVICE_URL || 'http://127.0.0.1:1595').replace(/\/$/, '');
const TOKEN = String(process.env.AI_PREVIEW_TOKEN || '');
const sessions = new Map();
const locks = new Map();

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(45000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Preview respondeu HTTP ${response.status}.`);
  return data;
}

async function update(userId, files) {
  const previous = locks.get(userId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    let id = sessions.get(userId);
    if (!id) {
      id = crypto.randomUUID();
      sessions.set(userId, id);
    }
    return request(`${BASE}/sessions`, { method: 'POST', body: JSON.stringify({ id, files }) });
  });
  locks.set(userId, current);
  try { return await current; }
  finally { if (locks.get(userId) === current) locks.delete(userId); }
}

module.exports = { update };
