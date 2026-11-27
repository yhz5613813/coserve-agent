import http from 'node:http';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Express } from 'express';
import { projectIdPattern } from './storage.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const hostname = (host: string | undefined) => (host ?? '').replace(/:\d+$/, '').toLowerCase();
/** Same rule as `/api`: a browser-sent Origin must be the CAStudio origin itself, because the worker origin is rewritten below. */
const sameSite = (req: IncomingMessage) => {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
};
const allowed = (req: IncomingMessage) => LOOPBACK.has(hostname(req.headers.host)) && sameSite(req);

/**
 * Serve each running parametric editor at `/pm/<project>/` on the CAStudio origin (HTTP and WebSocket),
 * so browsers never address the worker's random loopback port. Like `/api`, only loopback Hosts are
 * accepted: a gateway in front of CAStudio rewrites Host to 127.0.0.1:<STUDIO_PORT>.
 * Mount before the SPA fallback route.
 * @param app - CAStudio Express application.
 * @param workerPort - loopback port of a ready editor for a project id, or null.
 * @returns the listener for the HTTP server's `upgrade` event.
 */
export function mountParametricProxy(app: Express, workerPort: (id: string) => number | null) {
  app.use('/pm/:id', (req, res, next) => {
    if (!allowed(req)) { res.status(403).send('仅允许本机同源访问'); return; }
    const port = workerPort(String(req.params.id));
    if (!port) { res.status(502).send('参数化编辑器尚未就绪'); return; }
    const upstream = http.request({
      host: '127.0.0.1', port, path: req.url || '/', method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
    }, upRes => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); });
    upstream.on('error', error => { if (res.headersSent) res.destroy(); else next(error); });
    // A browser that navigates away must not leave the worker request (and its socket) open.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = /^\/pm\/([^/?]+)(.*)$/.exec(req.url || '');
    let id: string | null = null;
    try { id = match ? decodeURIComponent(match[1]) : null; } catch { id = null; }
    const port = id && projectIdPattern.test(id) && allowed(req) ? workerPort(id) : null;
    if (!match || !port) { socket.destroy(); return; }
    const upstream = net.connect(port, '127.0.0.1', () => {
      const headers = Object.entries(req.headers)
        .filter(([key]) => key !== 'host' && key !== 'origin')
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .concat([`host: 127.0.0.1:${port}`, `origin: http://127.0.0.1:${port}`]);
      upstream.write(`${req.method} ${match[2] || '/'} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  };
}
