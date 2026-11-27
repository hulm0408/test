// ===== Guaranteed Serialized .json Delivery Queue Worker =====
// Sends exported Toing .json files straight to the Telegram bot chat (NO shop bot).
// Features:
//   - Persistent SQLite delivery_queue -> zero lost files across restarts
//   - Configurable pacing (~1.05s gap = ~55 files/min safely inside Telegram DM limits)
//   - Automatic Telegram 429 retry_after handling + exponential retry backoff

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

function parseRetryAfterMs(err) {
  const sec = Number(err?.parameters?.retry_after || err?.response?.parameters?.retry_after || 0);
  if (Number.isFinite(sec) && sec > 0) return (sec + 1) * 1000;
  const msg = String(err?.message || err || '');
  const m = msg.match(/retry\s+after\s+(\d+)/i);
  if (m) return (Number(m[1]) + 1) * 1000;
  return 0;
}

function escHtml(s = '') {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class DeliveryWorker {
  constructor({
    db,
    sendDocument,
    getGapMs = () => 1_050,
    pollIntervalMs = 300,
  } = {}) {
    this.db = db;
    this.sendDocument = sendDocument; // async ({ chatId, buffer, filename, caption }) => void
    this.getGapMs = typeof getGapMs === 'function' ? getGapMs : () => Number(getGapMs) || 1_050;
    this.pollIntervalMs = Math.max(50, Number(pollIntervalMs) || 300);

    this.running = false;
    this.stopRequested = false;
    this._loopPromise = null;
    this.lastSentAt = 0;
    this.sentCount = 0;
    this.lastError = '';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this._loopPromise = this._loop().finally(() => {
      this.running = false;
    });
  }

  async stop({ drainMs = 5_000 } = {}) {
    this.stopRequested = true;
    if (this._loopPromise) {
      await Promise.race([
        this._loopPromise.catch(() => {}),
        sleep(drainMs),
      ]);
    }
    this.running = false;
  }

  async _deliverOne(item) {
    const buffer = Buffer.from(String(item.raw_json || '{}'), 'utf8');
    const filename = String(item.file_name || `toing-${item.phone}.json`);
    const tag = item.is_new ? '🆕 Fresh' : '♻️ Existing';
    const isFirebase = String(item.otp_bot || '').toLowerCase().startsWith('firebase');
    const sourceLine = isFirebase
      ? `📱 <code>${escHtml(item.phone)}</code> · 🔥 FB-Lane #${Math.abs(Number(item.slot_id || 0)) || '?'} (${escHtml(item.otp_bot)})`
      : `📱 <code>${escHtml(item.phone)}</code> · Slot #${item.slot_no || item.slot_id || '?'} (${escHtml(item.otp_bot || 'otp')})`;
    const caption = [
      `🌐 <b>TOING PRO</b> · ${tag}`,
      sourceLine,
      item.name ? `👤 ${escHtml(item.name)}` : '',
    ].filter(Boolean).join('\n');

    await this.sendDocument({
      chatId: item.chat_id,
      buffer,
      filename,
      caption,
      item,
    });
  }

  async _loop() {
    while (!this.stopRequested) {
      const item = this.db.getNextPendingDelivery(Date.now());
      if (!item) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      // Enforce clean pacing between consecutive Telegram document sends
      const gapMs = Math.max(0, Number(this.getGapMs()) || 0);
      const waitMs = (this.lastSentAt + gapMs) - Date.now();
      if (waitMs > 0 && !this.stopRequested) {
        await sleep(waitMs);
      }
      if (this.stopRequested) break;

      try {
        await this._deliverOne(item);
        this.db.markDeliverySent(item.id, item.session_id);
        this.lastSentAt = Date.now();
        this.sentCount += 1;
        this.lastError = '';
      } catch (err) {
        const retryAfterMs = parseRetryAfterMs(err);
        const backoffMs = retryAfterMs || Math.min(60_000, 3_000 * Math.pow(2, Math.min(4, item.attempts)));
        this.lastError = String(err?.message || err).slice(0, 180);
        this.db.markDeliveryRetry(item.id, {
          delayMs: backoffMs,
          error: this.lastError,
        });
        console.warn(`[Delivery] Retry #${item.attempts + 1} for ${item.phone} in ${Math.round(backoffMs / 1000)}s: ${this.lastError}`);
        if (retryAfterMs > 0) {
          await sleep(Math.min(retryAfterMs, 30_000));
        }
      }
    }
  }
}
