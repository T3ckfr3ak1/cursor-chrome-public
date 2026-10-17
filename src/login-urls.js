'use strict';

/**
 * Preferred login entry URLs — avoid passkey-first flows when possible.
 */
const LOGIN_URLS = {
  google:
    'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmyaccount.google.com&hl=en&passive=false',
  microsoft: 'https://login.live.com/',
  dropbox: 'https://www.dropbox.com/login',
};

/**
 * Rewrite Google accounts entry URLs to a password-friendly ServiceLogin.
 * Does not touch myaccount.google.com or other post-login destinations.
 */
function preferLoginUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'accounts.google.com') {
      return LOGIN_URLS.google;
    }
  } catch {
    /* keep original */
  }
  return url;
}

module.exports = { LOGIN_URLS, preferLoginUrl };
