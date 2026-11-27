import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp, apiGuard, healthRoute } from './app.js';
import { mountParametricProxy } from './parametric-proxy.js';
import { refreshDshGuides } from './dsh-workspace.js';
import { acquireLock } from './instance-lock.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.resolve(process.env.STUDIO_DATA_DIR || path.join(root, '.studio'));
const port = Number(process.env.STUDIO_PORT || 4317);
// Exit codes for the desktop: 75 = another live instance owns the data directory, 76 = the port cannot be bound.
const release = await acquireLock(dataRoot, process.env.STUDIO_INSTANCE ?? null).catch(error => { console.error(`CAStudio: ${(error as Error).message}`); process.exit(75); });
process.on('exit', release);
// Listen before recovery: /api/health answers at once (503, ok:false until projects can be served); other requests get 503 meanwhile.
let studio: Awaited<ReturnType<typeof createApp>> | undefined, upgradeParametric: ReturnType<typeof mountParametricProxy> | undefined;
const front = express(); front.disable('x-powered-by');
front.use('/api', apiGuard);
front.get('/api/health', healthRoute(() => !!studio));
front.use((req, res, next) => { if (studio) studio.app(req, res, next); else res.status(503).set('Retry-After', '2').json({ error: 'CAStudio 正在恢复项目，请稍候' }); });
const server = front.listen(port, '127.0.0.1', () => console.log(`CadFlow Studio → http://127.0.0.1:${port}`));
server.on('error', error => { console.error(`CAStudio: cannot listen on 127.0.0.1:${port}: ${error.message}`); process.exit(76); });
server.on('upgrade', (req, socket, head) => { if (upgradeParametric) upgradeParametric(req, socket, head); else socket.destroy(); });
let disposing = false;
const shutdown = () => {
  if (disposing) return; disposing = true;
  if (!studio) process.exit(0);
  const { optimizations, builds, thermal, thermalEditor, structural, parametric, cylinderObjects, cadInspections } = studio;
  void optimizations.dispose().then(() => Promise.allSettled([builds.dispose(), thermal.dispose(), thermalEditor.dispose(), structural.dispose(), parametric.dispose(), cylinderObjects.dispose(), cadInspections.dispose()])).finally(() => process.exit(0));
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, shutdown);
// The desktop holds our stdin open; its end means the desktop is gone.
if (process.env.STUDIO_PARENT_PIPE === '1') { process.stdin.on('end', shutdown); process.stdin.on('close', shutdown); process.stdin.resume(); }
const created = await createApp(dataRoot, { projects: process.env.STUDIO_PROJECTS_DIR ? path.resolve(process.env.STUDIO_PROJECTS_DIR) : undefined });
upgradeParametric = mountParametricProxy(created.app, created.parametric.workerPort);
if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  created.app.use(vite.middlewares);
} else {
  created.app.use(express.static(path.join(root, 'dist')));
  created.app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
}
studio = created;
// Guides written by an earlier launch name its port as their example URL.
void refreshDshGuides(created.store).catch(error => console.error(`CAStudio: refreshing project guides failed: ${(error as Error).message}`));
