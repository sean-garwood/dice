/*
 * Worker entry point: HTTP router in front of the Room Durable Object.
 * Routes (see docs/PROTOCOL.md):
 *   GET /health        -> 200 {"ok":true}
 *   GET /room/:code/ws -> WebSocket upgrade forwarded to the Room DO
 *   anything else      -> 404 JSON
 */
import { Room } from './room.js';

export { Room };

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json(200, { ok: true });
    }

    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{4,8})\/ws$/);
    if (request.method === 'GET' && m) {
      const code = m[1].toUpperCase();
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return json(426, { error: 'upgrade-required', message: 'This endpoint expects a WebSocket upgrade.' });
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      // Forward with the code normalized to uppercase so the DO sees it.
      const target = new URL(request.url);
      target.pathname = `/room/${code}/ws`;
      return stub.fetch(new Request(target.toString(), request));
    }

    return json(404, { error: 'not-found' });
  },
};
