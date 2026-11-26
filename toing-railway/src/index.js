// ===== Toing Railway (50 Parallel Slots) — Entrypoint =====
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { loadConfig } from './config.js';
import { ToingDb, bootstrapEnvSessions } from './db.js';
import { ToingClient } from './toing-client.js';
import { SlotManager } from './slot-manager.js';
import { DeliveryWorker } from './delivery-worker.js';
import { startHealthServer } from './health-server.js';
import { registerBotUi } from './bot-ui.js';

async function main() {
  const baseConfig = loadConfig(process.env);
  if (!baseConfig.botToken) {
    console.error('❌ BOT_TOKEN missing! Railway Variables me naya @BotFather token daalo.');
    process.exit(1);
  }

  // 1. Initialize SQLite (WAL) on Railway Persistent Volume (/data/toing.db)
  const db = new ToingDb({
    dbPath: baseConfig.dbPath,
    dataDir: baseConfig.dataDir,
    encryptionKey: baseConfig.vaultEncryptionKey,
    sessionsDir: baseConfig.sessionsDir,
  });

  // Clean any orphaned in-flight claims left over from a prior crash/redeploy
  const clearedClaims = db.clearAllActiveClaims();
  const seedRes = db.seedUsedNumbersFromFile(baseConfig.seedUsedNumbersFile, {
    defaultCooldownDays: baseConfig.usedCooldownDays,
  });
  const envBoot = bootstrapEnvSessions(db, process.env, {
    defaultOtpBot: baseConfig.defaultOtpBot,
    maxSlots: baseConfig.maxSlots,
  });

  console.log(`[Boot] SQLite WAL ready at ${baseConfig.dbPath} (encryption=${db.keySource})`);
  console.log(`[Boot] Seeded used numbers: added=${seedRes.added}, kept=${seedRes.kept}, expired=${seedRes.expired} | cleared stale claims=${clearedClaims}`);
  if (envBoot.added > 0) {
    console.log(`[Boot] Bootstrapped ${envBoot.added} TG spare account(s) from env`);
  }

  // Runtime config merges persistent SQLite settings over env defaults
  const getRuntimeConfig = () => {
    const s = db.getAllSettings();
    return {
      ...baseConfig,
      toingBaseUrl: String(s.toingBaseUrl || baseConfig.toingBaseUrl).replace(/\/+$/, ''),
      toingAccessKeys: Array.isArray(s.toingAccessKeys) && s.toingAccessKeys.length
        ? s.toingAccessKeys
        : baseConfig.toingAccessKeys,
      toingHttpConcurrency: Number(s.toingHttpConcurrency) || baseConfig.toingHttpConcurrency,
      defaultOtpBot: String(s.defaultOtpBot || baseConfig.defaultOtpBot),
      otpTimeoutMs: Number(s.otpTimeoutMs) || baseConfig.otpTimeoutMs,
      otpRefreshMs: Number(s.otpRefreshMs) || baseConfig.otpRefreshMs,
      autoFailoverBots: s.autoFailoverBots !== undefined ? Boolean(s.autoFailoverBots) : baseConfig.autoFailoverBots,
      poolRotateThreshold: Number(s.poolRotateThreshold) || baseConfig.poolRotateThreshold,
      skipRegistered: s.skipRegistered !== undefined ? Boolean(s.skipRegistered) : baseConfig.skipRegistered,
      otpTimeoutCooldownMin: s.otpTimeoutCooldownMin !== undefined ? Number(s.otpTimeoutCooldownMin) : baseConfig.otpTimeoutCooldownMin,
      deliveryChatId: String(s.deliveryChatId || baseConfig.deliveryChatId || baseConfig.primaryOwnerId || ''),
      autoResume: s.autoResume !== undefined ? Boolean(s.autoResume) : baseConfig.autoResume,
    };
  };

  // 2. Toing Pro HTTP Client (shared concurrency gate + multi-key round-robin)
  const toingClient = new ToingClient({
    getBaseUrl: () => getRuntimeConfig().toingBaseUrl,
    getAccessKeys: () => getRuntimeConfig().toingAccessKeys,
    concurrency: getRuntimeConfig().toingHttpConcurrency,
  });

  // 3. Telegram Control Bot
  const bot = new Telegraf(baseConfig.botToken);
  bot.catch((err) => {
    console.warn('[Telegraf] Unhandled error:', err?.message || err);
  });

  const sendOwnerAlert = async (html) => {
    const cfg = getRuntimeConfig();
    const target = cfg.deliveryChatId || cfg.primaryOwnerId;
    if (!target) return;
    await bot.telegram.sendMessage(target, html, { parse_mode: 'HTML' }).catch(() => {});
  };

  // 4. 50-Slot Parallel Manager
  const slotManager = new SlotManager({
    db,
    toingClient,
    getRuntimeConfig,
    onSignupSuccess: ({ slotNo, phone, isNew, durationMs }) => {
      console.log(`[Toing OK] Slot #${slotNo} | ${phone} | ${isNew ? 'NEW' : 'EXISTING'} | ${(durationMs / 1000).toFixed(1)}s`);
    },
    onSlotAlert: ({ slotNo, label, severity, code, message }) => {
      const icon = severity === 'dead' ? '⛔' : '⏳';
      console.warn(`[SlotAlert] #${slotNo} (${label}) ${code}: ${message}`);
      sendOwnerAlert(`${icon} <b>Slot #${slotNo} (${label})</b> — <code>${code}</code>\n<i>Baaki slots uninterrupted chal rahe hain.</i>`);
    },
  });

  // 5. Guaranteed Serialized .json Delivery Worker (NO shop bot — direct bot DM .json only)
  const deliveryWorker = new DeliveryWorker({
    db,
    getGapMs: () => getRuntimeConfig().deliveryGapMs,
    sendDocument: async ({ chatId, buffer, filename, caption }) => {
      try {
        await bot.telegram.sendDocument(chatId, { source: buffer, filename }, {
          caption,
          parse_mode: 'HTML',
        });
      } catch (err) {
        // Fallback plain caption if HTML parsing fails
        if (/parse|entities/i.test(String(err?.message || ''))) {
          await bot.telegram.sendDocument(chatId, { source: buffer, filename }, {
            caption: caption.replace(/<[^>]+>/g, ''),
          });
          return;
        }
        throw err;
      }
    },
  });

  registerBotUi({ bot, db, slotManager, toingClient, getRuntimeConfig });

  // 6. Start HTTP /health server immediately so Railway marks deployment healthy
  const healthServer = await startHealthServer({
    port: baseConfig.port,
    getHealthSnapshot: () => slotManager.getDashboardSnapshot(),
  });
  console.log(`[Health] Listening on http://0.0.0.0:${baseConfig.port}/health`);

  // 7. Start delivery queue worker
  deliveryWorker.start();

  // 8. Launch Telegraf long-polling
  bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('[Bot] Telegraf connected & listening'))
    .catch((err) => {
      console.error('[Bot] Telegraf launch error:', err?.message || err);
    });

  // 9. Auto-resume slots if cluster was running before Railway restart/redeploy
  const cfgNow = getRuntimeConfig();
  const wasRunning = db.getSetting('running', false);
  const accountCount = db.listAccounts({ onlyEnabled: true }).length;
  if (cfgNow.autoResume && wasRunning && accountCount > 0) {
    console.log(`[Boot] Auto-resuming ${accountCount} enabled slot(s)...`);
    slotManager.startAll().catch((err) => console.warn('[Boot] Auto-resume error:', err?.message || err));
  } else {
    console.log(`[Boot] Ready with ${accountCount} enabled slot(s). Send /start in Telegram to launch.`);
  }

  // 10. Graceful shutdown (Railway SIGTERM gives 30s)
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] Received ${signal} — draining active verify/exports & deliveries...`);
    try {
      await slotManager.stopAll({ gracefulMs: 18_000, persistStopped: false });
    } catch {}
    try {
      await deliveryWorker.stop({ drainMs: 5_000 });
    } catch {}
    try {
      bot.stop(signal);
    } catch {}
    try {
      await new Promise((r) => healthServer.close(r));
    } catch {}
    try {
      db.close();
    } catch {}
    console.log('[Shutdown] Clean exit complete.');
    process.exit(0);
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Fatal]', err?.stack || err);
  process.exit(1);
});
