'use strict';

const path = require('path');

const MAX_TABS = 20;
const DEFAULT_API_PORT = 9222;
const DEFAULT_CDP_PORT = 9223;
/** Shared persistent profile — cookies/logins survive restarts and are shared across tabs. */
const SHARED_PARTITION = 'persist:cursor-chrome-profile';

function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const getVal = (name, fallback) => {
    const idx = argv.indexOf(name);
    if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) {
      return argv[idx + 1];
    }
    const pref = `${name}=`;
    const hit = argv.find((a) => a.startsWith(pref));
    return hit ? hit.slice(pref.length) : fallback;
  };

  return {
    minimized: flags.has('--minimized'),
    hidden: flags.has('--hidden'),
    visible: flags.has('--visible'),
    /** Opt-in: isolate each thread's cookies (default is shared remembered logins). */
    isolateSessions:
      flags.has('--isolate-sessions') ||
      process.env.CURSOR_CHROME_ISOLATE_SESSIONS === '1',
    apiPort: Number(getVal('--api-port', process.env.CURSOR_CHROME_API_PORT || DEFAULT_API_PORT)),
    cdpPort: Number(getVal('--cdp-port', process.env.CURSOR_CHROME_CDP_PORT || DEFAULT_CDP_PORT)),
    maxTabs: Math.min(
      MAX_TABS,
      Math.max(1, Number(getVal('--max-tabs', process.env.CURSOR_CHROME_MAX_TABS || MAX_TABS)))
    ),
    userDataDir:
      getVal('--user-data-dir', process.env.CURSOR_CHROME_USER_DATA) ||
      path.join(require('os').homedir(), 'AppData', 'Local', 'Cursor-Chrome'),
  };
}

module.exports = {
  MAX_TABS,
  DEFAULT_API_PORT,
  DEFAULT_CDP_PORT,
  SHARED_PARTITION,
  APP_NAME: 'Cursor-Chrome',
  parseArgs,
};
