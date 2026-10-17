'use strict';

const fs = require('fs');
const path = require('path');

class RunLog {
  constructor({ maxEntries = 2000, file = null } = {}) {
    this.maxEntries = maxEntries;
    this.file = file || null;
    this._writes = 0;
    /** @type {object[]} */
    this.entries = [];
  }

  attachFile(file) {
    this.file = file;
  }

  add(entry) {
    const row = {
      id: this.entries.length + 1,
      ts: Date.now(),
      ...entry,
    };
    this.entries.push(row);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    this._persist(row);
    return row;
  }

  _persist(row) {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
      this._writes += 1;
      if (this._writes % 50 === 0) this._trimFile();
    } catch {
      /* logging must not break the browser */
    }
  }

  _trimFile() {
    try {
      const stat = fs.statSync(this.file);
      if (stat.size < 1024 * 1024) return;
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-800);
      fs.writeFileSync(this.file, `${lines.join('\n')}\n`, 'utf8');
    } catch {
      /* ignore */
    }
  }

  list({ threadId, tabId, limit = 100 } = {}) {
    let rows = this.entries;
    if (threadId) rows = rows.filter((e) => e.threadId === threadId);
    if (tabId) rows = rows.filter((e) => e.tabId === tabId);
    return rows.slice(-Math.max(1, limit));
  }

  clear() {
    this.entries = [];
  }
}

module.exports = { RunLog };
