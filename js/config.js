/*
 * Ten Thousand — online play configuration.
 * Plain script (no modules). Sets window.DICE_CONFIG for js/net.js and js/app.js.
 *
 * Default serverUrl:
 *   - hostname is localhost/127.0.0.1 → ws://localhost:8787
 *   - otherwise → wss://REPLACE-WITH-YOUR-WORKER.workers.dev (placeholder —
 *     replace with your deployed Worker's URL, or use ?server= to override)
 *
 * A `?server=wss://...` query param always overrides the default, and that
 * override is remembered here (serverOverride) so app.js can carry it into
 * room-share links.
 */
(function () {
  'use strict';

  function defaultServerUrl() {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return 'ws://localhost:8787';
    }
    return 'wss://REPLACE-WITH-YOUR-WORKER.workers.dev';
  }

  let override = null;
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('server');
    if (raw && raw.trim()) override = raw.trim();
  } catch {
    /* URLSearchParams unavailable — fall back to default */
  }

  window.DICE_CONFIG = {
    serverUrl: override || defaultServerUrl(),
    serverOverride: override,
  };
})();
