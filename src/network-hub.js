'use strict';

const fs = require('fs');
const path = require('path');
const { session } = require('electron');

/**
 * Lightweight network + download tracking per session partition / webContents.
 */
class NetworkHub {
  constructor({ downloadDir }) {
    this.downloadDir = downloadDir;
    fs.mkdirSync(downloadDir, { recursive: true });
    /** @type {Map<string, object[]>} */
    this.byTab = new Map();
    /** @type {object[]} */
    this.downloads = [];
    this.max = 500;
  }

  attachWebContents(tabId, wc) {
    if (!wc || wc._ccNetAttached) return;
    wc._ccNetAttached = true;
    const list = [];
    this.byTab.set(tabId, list);

    try {
      wc.session.setDownloadPath?.(this.downloadDir);
    } catch {
      /* ignore */
    }

    wc.session.on('will-download', (_e, item) => {
      const filename = item.getFilename();
      const savePath = path.join(this.downloadDir, filename);
      item.setSavePath(savePath);
      const rec = {
        tabId,
        filename,
        savePath,
        url: item.getURL(),
        state: 'progressing',
        startedAt: Date.now(),
      };
      this.downloads.push(rec);
      if (this.downloads.length > this.max) this.downloads.shift();
      item.on('updated', () => {
        rec.received = item.getReceivedBytes();
        rec.total = item.getTotalBytes();
      });
      item.once('done', (_ev, state) => {
        rec.state = state;
        rec.finishedAt = Date.now();
      });
    });

    // High-level request log via debugger when available is heavy; use webRequest filter.
    try {
      const filter = { urls: ['*://*/*'] };
      wc.session.webRequest.onCompleted(filter, (details) => {
        if (list.length > this.max) list.shift();
        list.push({
          ts: Date.now(),
          id: details.id,
          url: details.url,
          method: details.method,
          status: details.statusCode,
          type: details.resourceType,
          fromCache: details.fromCache,
        });
      });
    } catch {
      /* ignore */
    }
  }

  detach(tabId) {
    this.byTab.delete(tabId);
  }

  list(tabId, limit = 50) {
    const rows = this.byTab.get(tabId) || [];
    return rows.slice(-limit);
  }

  listDownloads(limit = 50) {
    return this.downloads.slice(-limit);
  }

  async waitForResponse(tabId, { urlIncludes, status, timeoutMs = 20000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = (this.byTab.get(tabId) || []).find((r) => {
        if (urlIncludes && !String(r.url).includes(urlIncludes)) return false;
        if (status && r.status !== status) return false;
        return true;
      });
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Object.assign(new Error('waitForResponse timeout'), { code: 'TIMEOUT' });
  }

  async waitForDownload({ filenameIncludes, timeoutMs = 60000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = [...this.downloads].reverse().find((d) => {
        if (d.state !== 'completed') return false;
        if (filenameIncludes && !d.filename.includes(filenameIncludes)) return false;
        return true;
      });
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw Object.assign(new Error('waitForDownload timeout'), { code: 'TIMEOUT' });
  }
}

/**
 * Block heavy resources for speed mode on a session.
 */
function applySpeedMode(ses, enabled) {
  if (!ses) return;
  if (!enabled) {
    try {
      ses.webRequest.onBeforeRequest(null);
    } catch {
      /* ignore */
    }
    return;
  }
  const block = ['image', 'media', 'font'];
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    // resourceType available on details in Electron
    const rt = details.resourceType;
    if (block.includes(rt)) return cb({ cancel: true });
    return cb({});
  });
}

module.exports = { NetworkHub, applySpeedMode };
