'use strict';

const fs = require('fs');
const path = require('path');
const { session } = require('electron');
const { SHARED_PARTITION } = require('./config');

const PROFILES = {
  shared: SHARED_PARTITION,
  work: 'persist:cursor-chrome-work',
  personal: 'persist:cursor-chrome-personal',
  isolated: null, // per-call
};

function partitionForProfile(name = 'shared', threadId) {
  if (name === 'isolated') {
    const key = String(threadId || 'tmp')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 40);
    return `persist:cursor-chrome-iso-${key || 'tmp'}`;
  }
  return PROFILES[name] || PROFILES.shared;
}

async function exportSession(partition = SHARED_PARTITION, outFile) {
  const ses = session.fromPartition(partition, { cache: true });
  await ses.flushStorageData();
  const cookies = await ses.cookies.get({});
  const payload = {
    exportedAt: new Date().toISOString(),
    partition,
    cookies,
  };
  const dest =
    outFile ||
    path.join(
      require('os').homedir(),
      'AppData',
      'Local',
      'Cursor-Chrome',
      'exports',
      `session-${Date.now()}.json`
    );
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2), 'utf8');
  return { ok: true, path: dest, cookies: cookies.length };
}

async function importSession(filePath, partition = SHARED_PARTITION) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const ses = session.fromPartition(partition, { cache: true });
  let n = 0;
  for (const c of raw.cookies || []) {
    try {
      const proto = c.secure ? 'https' : 'http';
      const domain = (c.domain || '').replace(/^\./, '');
      await ses.cookies.set({
        url: `${proto}://${domain}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate,
        sameSite: c.sameSite,
      });
      n += 1;
    } catch {
      /* skip bad cookie */
    }
  }
  await ses.flushStorageData();
  return { ok: true, imported: n, partition };
}

module.exports = {
  PROFILES,
  partitionForProfile,
  exportSession,
  importSession,
};
