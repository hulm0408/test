// ===== Railway HTTP Health & Metrics Server (0.0.0.0:$PORT) =====
import http from 'node:http';

export function startHealthServer({ port = 3000, getHealthSnapshot } = {}) {
  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/health' || urlPath === '/') {
      const snap = typeof getHealthSnapshot === 'function' ? getHealthSnapshot() : {};
      const body = JSON.stringify({
        ok: true,
        service: 'toing-railway-50slot',
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        running: Boolean(snap.desiredRunning),
        slots: {
          total: snap.totalSlots || 0,
          running: snap.runningCount || 0,
          ready: snap.readyCount || 0,
          cooldown: snap.cooldownCount || 0,
          dead: snap.deadCount || 0,
        },
        throughput: {
          rate1m: snap.throughput?.rate1m || 0,
          rate5m: snap.throughput?.rate5m || 0,
          rate15m: snap.throughput?.rate15m || 0,
          hitRate5m: snap.throughput?.hitRate5m || 0,
          totalSessions: snap.throughput?.totalSessions || 0,
        },
        delivery: snap.delivery || { pending: 0, sent: 0, failed: 0 },
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }

    if (urlPath === '/metrics') {
      const snap = typeof getHealthSnapshot === 'function' ? getHealthSnapshot() : {};
      const body = JSON.stringify({
        ok: true,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        ...snap,
      }, null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"ok":false,"error":"not_found"}');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      resolve(server);
    });
  });
}
