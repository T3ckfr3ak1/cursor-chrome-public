'use strict';

/**
 * Resolve which Cursor thread is attempting a mutating action.
 * Agents should pass body.threadId or header X-Cursor-Thread matching the tab owner.
 */
function requestThreadId(req) {
  const body = req.body || {};
  const q = req.query || {};
  return (
    body.threadId ||
    q.threadId ||
    req.headers['x-cursor-thread'] ||
    req.headers['x-thread-id'] ||
    null
  );
}

/**
 * Soft ownership: if the caller supplies a threadId, it must match the tab.
 * If omitted, allow (backward compatible) but prefer agents always pass it.
 */
function enforceThreadAccess(tabPool, tabId, req) {
  const threadId = requestThreadId(req);
  if (!threadId) return tabPool.get(tabId);
  return tabPool.assertThreadAccess(tabId, threadId);
}

module.exports = { requestThreadId, enforceThreadAccess };
