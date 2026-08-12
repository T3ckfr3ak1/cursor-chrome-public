'use strict';

class RunLog {
  constructor({ maxEntries = 2000 } = {}) {
    this.maxEntries = maxEntries;
    /** @type {object[]} */
    this.entries = [];
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
    return row;
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
