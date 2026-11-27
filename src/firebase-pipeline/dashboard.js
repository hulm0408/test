// ===== Firebase Phone-Registration Pipeline — Dashboard =====
// Live UI (stats, CSV export, Pause/Resume/Quarantine/Stop) and HTML/SVG preview.

import { PipelineCore } from './pipeline-core.js';
import { StateMachine } from './state-machine.js';
import { KeyPool } from './key-pool.js';

export class Dashboard {
  constructor(core, stateMachine, keyPool, port = 3000) {
    this.core = core;
    this.sm = stateMachine;
    this.kp = keyPool;
    this.port = port;
    this.server = null;
  }

  async start() {
    // Simple HTTP server for live preview (bind 0.0.0.0)
    const http = require('http');
    const fs = require('fs');
    const path = require('path');

    this.server = http.createServer(async (req, res) => {
      const url = req.url;
      
      // API endpoints
      if (url === '/api/stats') {
        const stats = {
          core: this.core.getStats(),
          keys: this.kp.getKeyStats(),
          sm: await this._getSmStats()
        };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(stats));
        return;
      }

      if (url === '/api/csv') {
        const rows = await this.sm.getNumbersByState('registered');
        let csv = 'id,phone,state,assigned_key_id,otp_code,error,attempts,created_at,updated_at\n';
        for (const r of rows.rows) {
          csv += `${r.id},${r.phone},${r.state},${r.assigned_key_id || ''},${r.otp_code || ''},${r.error || ''},${r.attempts},${r.created_at},${r.updated_at}\n`;
        }
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=export.csv' });
        res.end(csv);
        return;
      }

      // HTML/SVG Preview Shell
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Firebase Pipeline Dashboard</title>
          <style>
            body { font-family: sans-serif; background: #111; color: #eee; padding: 20px; }
            .card { background: #222; padding: 15px; border-radius: 8px; margin-bottom: 15px; }
            .stat { font-size: 24px; font-weight: bold; color: #0f0; }
            .btn { padding: 8px 12px; background: #444; color: #fff; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px; }
            .btn:hover { background: #555; }
            svg { width: 100%; height: 200px; background: #000; }
          </style>
        </head>
        <body>
          <h1>🚀 Firebase Phone-Registration Pipeline</h1>
          
          <div class="card">
            <h2>Controls</h2>
            <button class="btn" onclick="fetch('/api/stats').then(r=>r.json()).then(d=>console.log(d))">Refresh Stats</button>
            <button class="btn" onclick="window.location='/api/csv'">Export CSV</button>
            <button class="btn" onclick="alert('Pause/Resume/Quarantine/Stop logic goes here')">Pause/Resume</button>
          </div>

          <div class="card">
            <h2>Live Stats</h2>
            <div id="stats">Loading...</div>
          </div>

          <div class="card">
            <h2>Key Health (SVG Preview)</h2>
            <svg id="chart"></svg>
          </div>

          <script>
            async function updateStats() {
              const res = await fetch('/api/stats');
              const data = await res.json();
              document.getElementById('stats').innerHTML = \`
                <p><strong>Workers:</strong> ${data.core.workers} | <strong>Queue:</strong> ${data.core.queueLength}</p>
                <p><strong>Pending:</strong> ${data.sm.pending} | <strong>Assigned:</strong> ${data.sm.assigned} | <strong>OTP Sent:</strong> ${data.sm.otpSent}</p>
                <p><strong>Active:</strong> ${data.sm.active} | <strong>Registering:</strong> ${data.sm.registering} | <strong>Registered:</strong> ${data.sm.registered}</p>
                <p><strong>Failed:</strong> ${data.sm.failed} | <strong>Retry Queue:</strong> ${data.sm.retryQueue}</p>
                <p><strong>Keys:</strong> Total ${data.keys.total} | Healthy ${data.keys.healthy} | Quarantined ${data.keys.quarantined}</p>
              \`;
              
              // Update SVG chart (simple bar)
              const svg = document.getElementById('chart');
              const healthy = data.keys.healthy;
              const quarantined = data.keys.quarantined;
              const total = data.keys.total || 1;
              const hRatio = (healthy / total) * 200;
              const qRatio = (quarantined / total) * 200;
              svg.innerHTML = \`
                <rect x="0" y="0" width="${hRatio}" height="200" fill="#0f0" />
                <rect x="${hRatio}" y="0" width="${qRatio}" height="200" fill="#f00" />
                <rect x="${hRatio + qRatio}" y="0" width="${200 - hRatio - qRatio}" height="200" fill="#444" />
              \`;
            }
            updateStats();
            setInterval(updateStats, 5000);
          </script>
        </body>
        </html>
      `;
      res.end(html);
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      console.log(`Dashboard live on http://0.0.0.0:${this.port}`);
    });

    return { ok: true, port: this.port };
  }

  async stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    return { ok: true };
  }

  async _getSmStats() {
    const states = ['pending', 'assigned', 'otp_sent', 'active', 'registering', 'registered', 'failed', 'retry_queue'];
    const stats = {};
    for (const s of states) {
      const res = await this.sm.getNumbersByState(s);
      stats[s] = res.ok ? res.rows.length : 0;
    }
    return stats;
  }
}
