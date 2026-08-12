'use strict';

/**
 * Realtime tab frames for Cursor agents.
 * Primary: CDP Page.screencast. Fallback: capturePage polling (works for background / minimized tabs).
 */
class FrameHub {
  constructor({ getWebContents }) {
    this.getWebContents = getWebContents;
    /** @type {Map<string, object>} */
    this.streams = new Map();
  }

  meta(tabId) {
    const s = this.streams.get(tabId);
    if (!s) return { tabId, streaming: false };
    return {
      tabId,
      streaming: true,
      mode: s.mode,
      fpsTarget: s.fpsTarget,
      viewers: s.viewers,
      lastFrameAt: s.lastFrameAt,
      frameCount: s.frameCount,
      bytes: s.latest ? s.latest.length : 0,
      lastError: s.lastError || null,
    };
  }

  latest(tabId) {
    return this.streams.get(tabId)?.latest || null;
  }

  _publish(stream, buf) {
    if (!buf || !buf.length) return;
    stream.latest = buf;
    stream.lastFrameAt = Date.now();
    stream.frameCount += 1;

    for (const ws of stream.wsClients) {
      if (ws.readyState === 1) {
        try {
          ws.send(buf);
        } catch {
          /* ignore */
        }
      }
    }

    for (const res of stream.mjpegClients) {
      try {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
        res.write(buf);
        res.write('\r\n');
      } catch {
        stream.mjpegClients.delete(res);
      }
    }
  }

  async ensure(tabId, { quality = 55, maxWidth = 1280, maxHeight = 720, everyNthFrame = 1, sticky = false, fps = 8 } = {}) {
    const existing = this.streams.get(tabId);
    if (existing) {
      existing.viewers += 1;
      if (sticky) existing.sticky = true;
      return existing;
    }

    const wc = this.getWebContents(tabId);
    if (!wc || wc.isDestroyed()) {
      const err = new Error('Tab not found');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const stream = {
      tabId,
      wc,
      latest: null,
      lastFrameAt: 0,
      frameCount: 0,
      viewers: 1,
      sticky: !!sticky,
      mode: 'starting',
      fpsTarget: fps,
      wsClients: new Set(),
      mjpegClients: new Set(),
      quality,
      maxWidth,
      maxHeight,
      everyNthFrame,
      onMessage: null,
      pollTimer: null,
      watchdog: null,
      stopping: false,
    };

    this.streams.set(tabId, stream);

    // Always start capturePage poll — reliable for minimized / unfocused BrowserViews.
    this._startPoll(stream, fps, quality);

    // Also try CDP screencast (may produce frames when the view is composited).
    this._tryScreencast(stream).catch(() => {});

    return stream;
  }

  _startPoll(stream, fps, quality) {
    const interval = Math.max(50, Math.round(1000 / Math.max(1, fps)));
    const tick = async () => {
      if (stream.stopping || !this.streams.has(stream.tabId)) return;
      try {
        const wc = stream.wc;
        if (!wc || wc.isDestroyed()) return;
        if (stream.mode === 'screencast' && Date.now() - stream.lastFrameAt < interval * 1.5) {
          return;
        }
        const image = await wc.capturePage();
        if (stream.stopping) return;
        if (!image || image.isEmpty()) {
          stream.lastError = 'empty capturePage';
          return;
        }
        const buf = image.toJPEG(quality);
        if (!buf || buf.length < 100) {
          stream.lastError = 'tiny jpeg';
          return;
        }
        if (stream.mode !== 'screencast') stream.mode = 'poll';
        stream.lastError = null;
        this._publish(stream, buf);
      } catch (err) {
        stream.lastError = String(err.message || err);
      }
    };
    stream.pollTimer = setInterval(tick, interval);
    tick();
  }

  async _tryScreencast(stream) {
    const wc = stream.wc;
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }
    } catch (err) {
      if (!String(err.message || err).includes('Already attached')) return;
    }

    stream.onMessage = async (_event, method, params) => {
      if (method !== 'Page.screencastFrame' || stream.stopping) return;
      try {
        const buf = Buffer.from(params.data, 'base64');
        stream.mode = 'screencast';
        this._publish(stream, buf);
        await wc.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId });
      } catch {
        /* ignore */
      }
    };

    wc.debugger.on('message', stream.onMessage);
    try {
      await wc.debugger.sendCommand('Page.enable');
      await wc.debugger.sendCommand('Page.startScreencast', {
        format: 'jpeg',
        quality: stream.quality,
        maxWidth: stream.maxWidth,
        maxHeight: stream.maxHeight,
        everyNthFrame: stream.everyNthFrame,
      });
    } catch {
      try {
        wc.debugger.removeListener('message', stream.onMessage);
      } catch {
        /* ignore */
      }
    }
  }

  release(tabId) {
    const stream = this.streams.get(tabId);
    if (!stream) return;
    stream.viewers = Math.max(0, stream.viewers - 1);
    if (
      !stream.sticky &&
      stream.viewers === 0 &&
      stream.wsClients.size === 0 &&
      stream.mjpegClients.size === 0
    ) {
      this.stop(tabId);
    }
  }

  addWs(tabId, ws) {
    const stream = this.streams.get(tabId);
    if (!stream) return false;
    stream.wsClients.add(ws);
    if (stream.latest && ws.readyState === 1) ws.send(stream.latest);
    ws.on('close', () => {
      stream.wsClients.delete(ws);
      this.release(tabId);
    });
    return true;
  }

  addMjpeg(tabId, res) {
    const stream = this.streams.get(tabId);
    if (!stream) return false;
    stream.mjpegClients.add(res);
    res.on('close', () => {
      stream.mjpegClients.delete(res);
      this.release(tabId);
    });
    if (stream.latest) {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${stream.latest.length}\r\n\r\n`);
      res.write(stream.latest);
      res.write('\r\n');
    }
    return true;
  }

  async stop(tabId) {
    const stream = this.streams.get(tabId);
    if (!stream) return;
    stream.stopping = true;
    this.streams.delete(tabId);

    if (stream.pollTimer) clearInterval(stream.pollTimer);

    try {
      if (stream.onMessage) stream.wc.debugger.removeListener('message', stream.onMessage);
    } catch {
      /* ignore */
    }
    try {
      if (stream.wc.debugger.isAttached()) {
        await stream.wc.debugger.sendCommand('Page.stopScreencast').catch(() => {});
        stream.wc.debugger.detach();
      }
    } catch {
      /* ignore */
    }

    for (const ws of stream.wsClients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    for (const res of stream.mjpegClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }

  async stopAll() {
    const ids = [...this.streams.keys()];
    for (const id of ids) await this.stop(id);
  }
}

module.exports = { FrameHub };
