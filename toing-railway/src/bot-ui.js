// ===== Telegram Control Bot UI (Telegraf) — Pure Toing 50-Slot Cluster =====
import { Markup } from 'telegraf';
import QRCode from 'qrcode';
import { OTP_BOT_PROFILES, OTP_BOT_PROFILE_IDS, normalizeOtpBotProfileId } from './otp-profiles.js';
import { parseBulkSessionsInput } from './db.js';
import {
  formatCodeDeliverySummary,
  loginInteractiveSession,
  loginQrSession,
} from './telegram-slot-client.js';
import { verifyFirebaseSource } from './firebase-client.js';
import { REPORT_FILE, REPORT_KEY, formatPresenceReport, parsePresenceReport } from './firebase-presence-report.js';
import { readTextDocument } from './telegram-text-document.js';
import { parseCsvList } from './config.js';

function esc(s = '') {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtDuration(sec = 0) {
  const s = Math.max(0, Math.round(sec));
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${s}s`;
}

export function registerBotUi({ bot, db, slotManager, firebaseManager = null, toingClient, getRuntimeConfig, fetchImpl = fetch }) {
  // Per-chat interactive state (import prompt / phone login flow / setkey prompt / fb_add prompt)
  const chatModes = new Map(); // chatId -> { type: 'import'|'setkey'|'login'|'fb_add', ... }

  async function switchFirebaseMode(enable) {
    const next = Boolean(enable);
    const wasRunning = Boolean(slotManager.desiredRunning || firebaseManager?.desiredRunning || db.getSetting('running', false));
    db.setSetting('firebaseMode', next);

    if (next) {
      // Turning Firebase Fresh-Only Mode ON -> cleanly stop TG slots if active, then start Firebase if running
      if (slotManager.desiredRunning || slotManager.getDashboardSnapshot().runningCount > 0) {
        await slotManager.stopAll({ gracefulMs: 10_000, persistStopped: false });
      }
      if (wasRunning && firebaseManager) {
        const res = await firebaseManager.start();
        return { enabled: true, started: Boolean(res?.ok), reason: res?.reason || '' };
      }
      return { enabled: true, started: false, reason: '' };
    }

    // Turning Firebase Mode OFF -> stop Firebase cleanly, restore TG slots if running
    if (firebaseManager && (firebaseManager.desiredRunning || firebaseManager.running)) {
      await firebaseManager.stop({ gracefulMs: 10_000, persistStopped: false });
    }
    if (wasRunning) {
      const enabledSlots = db.listAccounts({ onlyEnabled: true }).length;
      if (enabledSlots > 0) {
        await slotManager.startAll();
        return { enabled: false, started: true, reason: '' };
      }
    }
    return { enabled: false, started: false, reason: '' };
  }

  const isOwner = (userId) => {
    const cfg = getRuntimeConfig();
    if (!cfg.ownerIds.length) return true;
    return cfg.ownerIds.includes(String(userId || ''));
  };

  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!isOwner(uid)) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('⛔ Unauthorized — sirf owner control kar sakta hai.', { show_alert: true }).catch(() => {});
      } else if (ctx.message) {
        await ctx.reply(`⛔ Unauthorized. Your Telegram ID: <code>${esc(uid)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
      }
      return;
    }
    return next();
  });

  // ── Dashboard Builder ──────────────────────────────────────────────────────
  function buildDashboard() {
    const cfg = getRuntimeConfig();
    const snap = slotManager.getDashboardSnapshot();
    const fbSnap = firebaseManager ? firebaseManager.getSnapshot() : {
      desiredRunning: false,
      running: false,
      activeLanes: 0,
      stages: {},
      currentSource: null,
      sourceIndex: 0,
      runSourcesTotal: 0,
      hotQueueSize: 0,
      currentPoolSize: 0,
      currentUnseenSize: 0,
      createdInRun: 0,
      skippedRegisteredInRun: 0,
      otpTimeoutsInRun: 0,
      lastError: '',
      health: db.getFirebaseHealthSummary(),
    };
    const fbMode = Boolean(cfg.firebaseMode);
    const presenceLine = formatPresenceReport(db.getSetting(REPORT_KEY));
    const t = snap.throughput;
    const d = snap.delivery;

    const isEngineRunning = fbMode ? fbSnap.desiredRunning : snap.desiredRunning;
    const rateStatus = !isEngineRunning
      ? '⏸ STOPPED'
      : t.rate1m >= cfg.targetAccountsPerMin
        ? '🟢 ON TARGET'
        : t.rate5m >= cfg.targetAccountsPerMin
          ? '🟢 STEADY'
          : (fbMode ? fbSnap.activeLanes > 0 : snap.runningCount > 0)
            ? '🟡 RUNNING'
            : '🔴 IDLE';

    const fbStageLine = Object.entries(fbSnap.stages || {})
      .filter(([, c]) => c > 0)
      .map(([k, c]) => `${k}:${c}`)
      .join(' · ');

    const tgStageLine = Object.entries(snap.stages)
      .filter(([, c]) => c > 0)
      .map(([k, c]) => `${k}:${c}`)
      .join(' · ');

    const lines = fbMode
      ? [
        `🔥 <b>TOING PRO — FIREBASE FRESH-ONLY</b>  [${rateStatus}]`,
        ``,
        `⚡ <b>Throughput:</b> <code>${t.rate1m}/min</code> (1m) · <code>${t.rate5m}/min</code> (5m) · <code>${t.rate15m}/min</code> (15m)`,
        `📦 <b>Total Created:</b> <code>${t.totalSessions}</code> (1h: <code>${t.last1h}</code> · run: <code>${fbSnap.createdInRun}</code>) · <b>Cooldown:</b> <code>${t.usedActive}</code>`,
        `🚫 <b>Already-Registered Auto-Skip:</b> <b>ON ✅</b> (run skipped: <code>${fbSnap.skippedRegisteredInRun}</code> · 5m: <code>${t.alreadyRegistered5m || 0}</code>)`,
        `🔍 <b>5m Drops:</b> ⏱ OTP Timeout <code>${t.timeouts5m || 0}</code> · ❌ Fail <code>${(t.sendFails5m || 0) + (t.verifyFails5m || 0) + (t.checkFails5m || 0)}</code>`,
        ``,
        `🔥 <b>Saved Firebase databases:</b> <code>${fbSnap.health.total}</code> (🟢 ${fbSnap.health.live} live · ⏳ ${fbSnap.health.quarantined} quar · ⚪ ${fbSnap.health.neverTried} new)`,
        presenceLine,
        fbSnap.currentSource
          ? `📡 <b>Active DB:</b> <code>${esc(fbSnap.currentSource.name)}</code> (${fbSnap.sourceIndex}/${fbSnap.runSourcesTotal}) · Pool: <code>${fbSnap.currentUnseenSize}/${fbSnap.currentPoolSize}</code> · HotQ: <code>${fbSnap.hotQueueSize}</code>`
          : `📡 <b>Active DB:</b> <i>${fbSnap.desiredRunning ? 'Loading / scanning...' : 'Stopped'}</i>`,
        `⚡ <b>FB Lanes:</b> <code>${fbSnap.activeLanes}/${cfg.firebaseConcurrency}</code> · <b>FB OTP Timeout:</b> <code>${Math.round(cfg.firebaseOtpTimeoutMs / 1000)}s</code>`,
        fbStageLine ? `🔄 <b>Stages:</b> <code>${esc(fbStageLine)}</code>` : '',
        `📤 <b>Delivery Queue:</b> <code>${d.pending}</code> pending · <code>${d.sent}</code> sent · <code>${d.failed}</code> failed`,
        `🔑 <b>Toing Keys:</b> <code>${snap.toing.keysCount}</code> · <b>HTTP Gate:</b> <code>${snap.toing.semaphore.active}/${snap.toing.semaphore.limit}</code> (429: ${snap.toing.rateLimited429})`,
      ].filter(Boolean)
      : [
        `🌐 <b>TOING PRO — 50-SLOT CLUSTER</b>  [${rateStatus}]`,
        ``,
        `⚡ <b>Throughput:</b> <code>${t.rate1m}/min</code> (1m) · <code>${t.rate5m}/min</code> (5m) · <code>${t.rate15m}/min</code> (15m)`,
        `🎯 <b>Goal:</b> <code>${cfg.targetAccountsPerMin}+ acc/min</code> · <b>Hit Rate (5m):</b> <code>${t.hitRate5m}%</code> · <b>Avg:</b> <code>${t.avgSignupSec}s</code>`,
        `📦 <b>Total Created:</b> <code>${t.totalSessions}</code> (1h: <code>${t.last1h}</code>) · <b>Cooldown Pool:</b> <code>${t.usedActive}</code>`,
        `🔍 <b>5m Skips/Drops:</b> 🚫 Reg <code>${t.alreadyRegistered5m || 0}</code> · 🔁 Used/Dup <code>${t.duplicateSkips5m || 0}</code> · ⏱ OTP Timeout <code>${t.timeouts5m || 0}</code> · ❌ Fail <code>${(t.sendFails5m || 0) + (t.verifyFails5m || 0) + (t.checkFails5m || 0)}</code>`,
        ``,
        `👥 <b>Slots:</b> <code>${snap.totalSlots}/${cfg.maxSlots}</code>  (🟢 ${snap.readyCount} live · ⏳ ${snap.cooldownCount} cool · ⛔ ${snap.deadCount} dead · ⚪ ${snap.disabledCount} off)`,
        tgStageLine ? `🔄 <b>Stages:</b> <code>${esc(tgStageLine)}</code>` : '',
        `📤 <b>Delivery Queue:</b> <code>${d.pending}</code> pending · <code>${d.sent}</code> sent · <code>${d.failed}</code> failed`,
        `🔑 <b>Toing Keys:</b> <code>${snap.toing.keysCount}</code> · <b>HTTP Gate:</b> <code>${snap.toing.semaphore.active}/${snap.toing.semaphore.limit}</code> (429: ${snap.toing.rateLimited429})`,
        `🤖 <b>OTP Bot:</b> <code>${esc(cfg.defaultOtpBot)}</code> · <b>OTP Timeout:</b> <code>${Math.round(cfg.otpTimeoutMs / 1000)}s</code> · <b>Filter:</b> <code>${cfg.skipRegistered === true ? 'Fresh Only' : 'All Numbers ✅'}</code>`,
        `🔥 <b>Firebase Fresh-Only Mode:</b> <code>OFF</code> (${fbSnap.health.total} saved databases)`,
        presenceLine,
      ].filter(Boolean);

    const rows = [
      [
        fbMode
          ? (fbSnap.desiredRunning
            ? Markup.button.callback('🛑 STOP FIREBASE', 'act_fb_stop')
            : Markup.button.callback('🚀 START FIREBASE', 'act_fb_start'))
          : (snap.desiredRunning
            ? Markup.button.callback('🛑 STOP ALL', 'act_stop_all')
            : Markup.button.callback('🚀 START ALL', 'act_start_all')),
        Markup.button.callback('🔄 Refresh', 'act_dash'),
      ],
      [
        Markup.button.callback(
          fbMode ? '🔥 Firebase Mode: ON ✅' : '🔥 Firebase Mode: OFF',
          'act_toggle_fb_mode'
        ),
        Markup.button.callback(`🔥 FB Panel (${fbSnap.health.total} DBs)`, 'act_fb_panel'),
      ],
      [
        Markup.button.callback(`👥 Slots (${snap.totalSlots}/${cfg.maxSlots})`, 'slots_page_1'),
        Markup.button.callback('📥 Bulk Import', 'act_import'),
      ],
      [
        Markup.button.callback('📱 Add via Phone', 'act_add_phone'),
        Markup.button.callback('📷 Add via QR', 'act_add_qr'),
      ],
      [
        Markup.button.callback('⚙️ Settings', 'act_settings'),
        Markup.button.callback('📦 Export Last 50', 'act_export_50'),
      ],
      [
        Markup.button.callback('📜 Number Log', 'act_logs'),
        Markup.button.callback('🧊 Cooldowns', 'act_cooldowns'),
      ],
      [
        Markup.button.callback('♻️ Reset Health', 'act_reset_health'),
      ],
    ];

    return {
      text: lines.join('\n'),
      extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
    };
  }

  async function editOrReply(ctx, text, extra) {
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, extra);
        return;
      } catch (err) {
        if (/message is not modified/i.test(String(err?.message || ''))) return;
      }
    }
    await ctx.reply(text, extra).catch(() => {});
  }

  // ── Paginated Slots View ───────────────────────────────────────────────────
  function buildSlotsPage(page = 1) {
    const snap = slotManager.getDashboardSnapshot();
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(snap.slots.length / perPage));
    const cur = Math.min(totalPages, Math.max(1, Number(page) || 1));
    const slice = snap.slots.slice((cur - 1) * perPage, cur * perPage);

    const lines = [
      `👥 <b>SPARE TG SLOTS</b> — Page ${cur}/${totalPages} (${snap.slots.length} total)`,
      '',
    ];
    if (!slice.length) {
      lines.push('<i>Abhi koi spare Telegram account added nahi hai.</i>');
      lines.push('👉 <b>Bulk Import</b> ya <b>Add via Phone</b> se add karo.');
    } else {
      for (const s of slice) {
        const icon = !s.enabled
          ? '⚪'
          : s.healthStatus === 'dead'
            ? '⛔'
            : s.stage === 'cooldown' || s.cooldownLeftSec > 0
              ? '⏳'
              : s.running
                ? '🟢'
                : '🟡';
        const botEmoji = OTP_BOT_PROFILES[s.otpBot]?.emoji || '📨';
        const extraInfo = s.cooldownLeftSec > 0
          ? `cool ${fmtDuration(s.cooldownLeftSec)}`
          : s.currentPhone
            ? `${s.stage} ${s.currentPhone.slice(-4)}`
            : s.stage;
        lines.push(`${icon} <b>#${s.slotNo}</b> ${esc(s.label)} ${botEmoji} · <code>${esc(extraInfo)}</code> · ✅ ${s.totalCreated}`);
      }
    }

    const rows = [];
    // 2 slot buttons per row for fast tap-to-manage
    for (let i = 0; i < slice.length; i += 2) {
      const pair = slice.slice(i, i + 2).map((s) =>
        Markup.button.callback(`#${s.slotNo} ${s.label.slice(0, 12)}`, `slot_view_${s.id}_${cur}`)
      );
      rows.push(pair);
    }

    const nav = [];
    if (cur > 1) nav.push(Markup.button.callback('⬅️ Prev', `slots_page_${cur - 1}`));
    nav.push(Markup.button.callback('🔄', `slots_page_${cur}`));
    if (cur < totalPages) nav.push(Markup.button.callback('Next ➡️', `slots_page_${cur + 1}`));
    rows.push(nav);
    rows.push([
      Markup.button.callback('📥 Bulk Import', 'act_import'),
      Markup.button.callback('🏠 Dashboard', 'act_dash'),
    ]);

    return {
      text: lines.join('\n'),
      extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
    };
  }

  function buildSlotDetail(accountId, backPage = 1) {
    const snap = slotManager.getDashboardSnapshot();
    const s = snap.slots.find((x) => x.id === Number(accountId));
    if (!s) {
      return {
        text: '❌ Slot nahi mila.',
        extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `slots_page_${backPage}`)]]) },
      };
    }

    const lines = [
      `🎛 <b>SLOT #${s.slotNo} — ${esc(s.label)}</b>`,
      s.tgUserLabel ? `👤 TG: <code>${esc(s.tgUserLabel)}</code>` : '',
      `⚡ Status: <b>${s.running ? 'RUNNING' : 'STOPPED'}</b> · Enabled: <b>${s.enabled ? 'YES' : 'NO'}</b>`,
      `🔄 Stage: <code>${esc(s.stage)}</code> (${s.stageAgeSec}s) ${s.currentPhone ? `· 📱 <code>${s.currentPhone}</code>` : ''}`,
      `🩺 Health: <code>${esc(s.healthStatus)}</code> ${s.cooldownLeftSec > 0 ? `(⏳ ${fmtDuration(s.cooldownLeftSec)})` : ''}`,
      `🤖 OTP Bot: <b>${esc(OTP_BOT_PROFILES[s.otpBot]?.uiLabel || s.otpBot)}</b>`,
      `📊 Created: <code>${s.totalCreated}</code> (this run: <code>${s.createdInRun}</code>) · Attempts: <code>${s.totalAttempts}</code>`,
      s.lastError ? `⚠️ Last error: <code>${esc(s.lastError)}</code>` : '',
    ].filter(Boolean);

    const botButtons = OTP_BOT_PROFILE_IDS.map((pid) => {
      const p = OTP_BOT_PROFILES[pid];
      const mark = s.otpBot === pid ? '✅ ' : '';
      return Markup.button.callback(`${mark}${p.emoji} ${p.label}`, `slot_bot_${s.id}_${pid}_${backPage}`);
    });

    const rows = [
      [
        s.running
          ? Markup.button.callback('⏹ Stop Slot', `slot_stop_${s.id}_${backPage}`)
          : Markup.button.callback('▶️ Start Slot', `slot_start_${s.id}_${backPage}`),
        Markup.button.callback('♻️ Reset Health', `slot_reset_${s.id}_${backPage}`),
      ],
      botButtons,
      [
        Markup.button.callback('🗑 Delete Slot', `slot_del_${s.id}_${backPage}`),
        Markup.button.callback('⬅️ Back', `slots_page_${backPage}`),
      ],
    ];

    return {
      text: lines.join('\n'),
      extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
    };
  }

  // ── Number Log View (Exact Reason For Every Number) ───────────────────────
  function buildNumberLogView(limit = 22) {
    const summary = db.getNumberEventSummary(5 * 60_000);
    const events = db.getRecentNumberEvents(limit);
    const r = summary.byReason || {};

    const lines = [
      `📜 <b>NUMBER LOG — HAR NUMBER KA EXACT REASON</b>`,
      ``,
      `📊 <b>Last 5 Min Breakdown (${summary.total} events):</b>`,
      `• ✅ Created New: <code>${r.created_new || 0}</code>` + (r.created_existing ? ` · Existing: <code>${r.created_existing}</code>` : ''),
      `• 🚫 Already Registered (OTP nahi bheja): <code>${r.already_registered || 0}</code>`,
      `• 🔁 Used / Cooldown / Seed Skip: <code>${r.used_cooldown || 0}</code>`,
      `• 🔒 In-Flight Duplicate (doosra slot): <code>${r.in_flight || 0}</code> · Bot Dup: <code>${r.bot_duplicate || 0}</code>`,
      `• ⏱ OTP Timeout: <code>${r.otp_timeout || 0}</code> · ❌ Send/Verify Fail: <code>${(r.send_otp_failed || 0) + (r.verify_failed || 0) + (r.check_mobile_failed || 0)}</code>`,
      ``,
      `🧾 <b>Latest ${events.length} Numbers:</b>`,
    ];

    if (!events.length) {
      lines.push('<i>Abhi tak koi number event record nahi hua hai.</i>');
    } else {
      const iconFor = (ev) => {
        if (ev.outcome === 'ok') return '✅';
        if (ev.reason === 'already_registered') return '🚫';
        if (ev.reason === 'used_cooldown' || ev.reason === 'in_flight' || ev.reason === 'bot_duplicate') return '🔁';
        if (ev.reason === 'otp_timeout') return '⏱';
        if (ev.outcome === 'claim_fail') return '⚠️';
        return '❌';
      };
      const now = Date.now();
      for (const ev of events) {
        const ageSec = Math.max(0, Math.round((now - Number(ev.created_at || now)) / 1000));
        const ageTxt = fmtDuration(ageSec);
        const phoneTxt = ev.phone ? `<code>${esc(ev.phone)}</code>` : '<i>no-phone</i>';
        const reasonTxt = esc(ev.reason || ev.outcome);
        const detailTxt = ev.detail ? ` — ${esc(ev.detail.slice(0, 68))}` : '';
        lines.push(`${iconFor(ev)} <b>#${ev.slot_no}</b> ${phoneTxt} [<code>${reasonTxt}</code>]${detailTxt} <i>(${ageTxt} ago)</i>`);
      }
    }

    const rows = [
      [
        Markup.button.callback('🔄 Refresh Log', 'act_logs'),
        Markup.button.callback('🧊 Cooldowns', 'act_cooldowns'),
        Markup.button.callback('🏠 Dashboard', 'act_dash'),
      ],
    ];

    return {
      text: lines.join('\n').slice(0, 3950),
      extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
    };
  }

  // ── Cooldowns View (Clear Breakdown + 1-Tap Controls) ──────────────────────
  function buildCooldownsView({ confirmAll = false } = {}) {
    const bd = db.getCooldownBreakdown();
    const snap = slotManager.getDashboardSnapshot();
    const coolSlots = snap.slots.filter((s) => s.cooldownLeftSec > 0 || s.stage === 'cooldown');
    const tempCount = (bd.otp_timeout_cool || 0) + (bd.send_otp_blocked || 0);

    const lines = [
      `🧊 <b>COOLDOWNS — FULL BREAKDOWN &amp; CONTROLS</b>`,
      ``,
      `📱 <b>1. Mobile Number Cooldown Pool (Total: <code>${bd.total}</code>)</b>`,
      `<i>Ye numbers isliye skip hote hain taaki OTP &amp; time waste na ho:</i>`,
      `• ✅ <b>extracted</b> (banaye hue accounts, 30d): <code>${bd.extracted}</code>`,
      `• 🚫 <b>already_registered</b> (Toing par pehle se reg, 30d): <code>${bd.already_registered}</code>`,
      `• ⛔ <b>suspended</b> (Swiggy account suspended, 30d): <code>${bd.suspended || 0}</code>`,
      `• 📦 <b>seed</b> (purane JSON backups, 30d): <code>${bd.seed}</code>`,
      `• ⏱ <b>otp_timeout_cool</b> (OTP nahi aaya, 10m): <code>${bd.otp_timeout_cool}</code>`,
      `• 🛑 <b>send_otp_blocked</b> (Swiggy limit, 2h): <code>${bd.send_otp_blocked}</code>`,
      bd.other ? `• 🔹 <b>other</b>: <code>${bd.other}</code>` : '',
      ``,
      `🤖 <b>2. Slot Telegram Cooldown (FLOOD_WAIT): <code>${coolSlots.length}</code> slot(s)</b>`,
      coolSlots.length
        ? coolSlots.slice(0, 8).map((s) => `• Slot <b>#${s.slotNo}</b>: ⏳ <code>${fmtDuration(s.cooldownLeftSec)}</code>`).join('\n')
        : `• <i>Sabhi slots fresh hain — koi TG FLOOD_WAIT nahi!</i>`,
    ].filter(Boolean);

    const rows = [
      [
        Markup.button.callback(`🧹 Clear Temp (${tempCount})`, 'cool_clear_temp'),
        Markup.button.callback(`🚫 Clear Already-Reg (${bd.already_registered})`, 'cool_clear_reg'),
      ],
      [
        Markup.button.callback(`📦 Clear Seed (${bd.seed})`, 'cool_clear_seed'),
        Markup.button.callback('♻️ Reset Slot TG Health', 'act_reset_health'),
      ],
      confirmAll
        ? [
          Markup.button.callback('⚠️ YES, CLEAR ALL NUMBERS', 'cool_clear_all_yes'),
          Markup.button.callback('❌ Cancel', 'act_cooldowns'),
        ]
        : [
          Markup.button.callback('🗑 Clear ALL Number Cooldowns', 'cool_clear_all_ask'),
        ],
      [
        Markup.button.callback('🔄 Refresh', 'act_cooldowns'),
        Markup.button.callback('🏠 Dashboard', 'act_dash'),
      ],
    ];

    return {
      text: lines.join('\n'),
      extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
    };
  }

  // ── 🔥 Firebase Fresh-Only Control Panel & Sources UI ─────────────────────
  function buildFirebasePanelView({ confirmDeleteAll = false } = {}) {
    const cfg = getRuntimeConfig();
    const fbSnap = firebaseManager ? firebaseManager.getSnapshot() : {
      desiredRunning: false,
      running: false,
      activeLanes: 0,
      stages: {},
      currentSource: null,
      sourceIndex: 0,
      runSourcesTotal: 0,
      hotQueueSize: 0,
      currentPoolSize: 0,
      currentUnseenSize: 0,
      createdInRun: 0,
      skippedRegisteredInRun: 0,
      otpTimeoutsInRun: 0,
      lastError: '',
      health: db.getFirebaseHealthSummary(),
    };
    const fbMode = Boolean(cfg.firebaseMode);
    const h = fbSnap.health;
    const primary = db.listFirebaseSources().find((s) => s.primary) || null;
    const stageStr = Object.entries(fbSnap.stages || {})
      .filter(([, c]) => c > 0)
      .map(([k, c]) => `${k}:${c}`)
      .join(' · ');

    const lines = [
      `🔥 <b>FIREBASE FRESH-ONLY REGISTRATION</b>`,
      ``,
      `🔘 <b>Firebase Mode:</b> <b>${fbMode ? 'ON ✅ (Active)' : 'OFF (Telegram OTP Bots Active)'}</b>`,
      `🚫 <b>Already-Registered Rule:</b> <b>Hamesha SKIP ✅</b> (sirf FRESH <code>is_new=true</code> par OTP &amp; signup)`,
      `⚡ <b>Engine:</b> <b>${fbSnap.desiredRunning ? `RUNNING (${fbSnap.activeLanes}/${cfg.firebaseConcurrency} lanes)` : 'STOPPED'}</b> · <b>FB OTP:</b> <code>${Math.round((cfg.firebaseOtpProbeMs ?? 25_000) / 1000)}s probe</code> → <code>${Math.round(cfg.firebaseOtpTimeoutMs / 1000)}s</code> (jo DB OTP de chuka hai uske liye full wait)`,
      stageStr ? `🔄 <b>Stages:</b> <code>${esc(stageStr)}</code>` : '',
      `📊 <b>This Run:</b> ✅ Fresh Created <code>${fbSnap.createdInRun}</code> · 🚫 Reg Skipped <code>${fbSnap.skippedRegisteredInRun}</code> · ⏱ Timeout <code>${fbSnap.otpTimeoutsInRun}</code>`,
      ``,
      `🗂 <b>Saved Firebase databases:</b> <code>${h.total}</code> (🟢 ${h.live} live · ⏳ ${h.quarantined} quar · ❌ ${h.failed} fail · ⚪ ${h.neverTried} new)`,
      `📬 <b>OTP delivery proof:</b> ✅ <code>${h.otpProven || 0}</code> DBs ne asli OTP diya · ⛔ <code>${h.otpDead || 0}</code> DBs OTP hi nahi dete (auto-demote 45m)`,
      `<i>Sirf "pool load hua" kaafi nahi — asli test OTP aana hai. Jo DB OTP nahi deta wo peeche chala jata hai, aur jo device inbox me SMS nahi bhejta wo 30m skip hota hai.</i>`,
      formatPresenceReport(db.getSetting(REPORT_KEY)),
      `Count update: owner DM mein <code>${REPORT_FILE}</code> bhejo. Pehli line <code>status</code>, phir har distinct number ke liye sirf <code>active</code>, <code>inactive</code> ya <code>unknown</code>, ek per line. Numbers ya URLs nahi.`,
      primary ? `⭐ <b>First-Try Source:</b> <code>${esc(primary.name)}</code>` : `⚠️ <i>Koi Firebase source added nahi — Add Firebase (Bulk) se daalo.</i>`,
      fbSnap.currentSource
        ? `📡 <b>Now Scanning:</b> <code>${esc(fbSnap.currentSource.name)}</code> (${fbSnap.sourceIndex}/${fbSnap.runSourcesTotal}) · Unseen <code>${fbSnap.currentUnseenSize}/${fbSnap.currentPoolSize}</code> · HotQ <code>${fbSnap.hotQueueSize}</code>`
        : '',
      fbSnap.lastError ? `⚠️ <b>Last Error:</b> <code>${esc(fbSnap.lastError)}</code>` : '',
    ].filter(Boolean);

    const rows = [
      [
        Markup.button.callback(
          fbMode ? '🔥 Firebase Mode: ON ✅ (Tap OFF)' : '🔥 Firebase Mode: OFF (Tap ON)',
          'act_toggle_fb_mode'
        ),
      ],
      [
        fbSnap.desiredRunning
          ? Markup.button.callback('🛑 STOP FIREBASE', 'act_fb_stop')
          : Markup.button.callback('🚀 START FIREBASE', 'act_fb_start'),
        Markup.button.callback('🔄 Refresh', 'act_fb_panel'),
      ],
      [
        Markup.button.callback(`⚡ 5`, 'fb_lanes_5'),
        Markup.button.callback(`⚡ 12`, 'fb_lanes_12'),
        Markup.button.callback(`⚡ 20`, 'fb_lanes_20'),
        Markup.button.callback(`⚡ 30`, 'fb_lanes_30'),
      ],
      [
        Markup.button.callback(`⏱ 30s`, 'fb_otp_30000'),
        Markup.button.callback(`⏱ 45s`, 'fb_otp_45000'),
        Markup.button.callback(`⏱ 60s`, 'fb_otp_60000'),
        Markup.button.callback(`⏱ 90s`, 'fb_otp_90000'),
      ],
      [
        Markup.button.callback(`📋 Sources (${h.total})`, 'fb_sources_page_1'),
        Markup.button.callback('➕ Add Firebase (Bulk)', 'fb_src_add'),
      ],
      [
        Markup.button.callback('♻️ Reset FB Health', 'fb_src_reset_health'),
        confirmDeleteAll
          ? Markup.button.callback('⚠️ YES, DELETE ALL FB', 'fb_src_del_all_yes')
          : Markup.button.callback('🗑 Delete All FB', 'fb_src_del_all_ask'),
      ],
      [
        Markup.button.callback('🏠 Dashboard', 'act_dash'),
      ],
    ];

    return {
      text: lines.join('\n'),
      extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
    };
  }

  function buildFirebaseSourcesPage(page = 1) {
    const list = db.listFirebaseRunSources();
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(list.length / perPage));
    const cur = Math.min(totalPages, Math.max(1, Number(page) || 1));
    const slice = list.slice((cur - 1) * perPage, cur * perPage);
    const now = Date.now();

    const lines = [
      `📋 <b>FIREBASE SOURCES</b> — Page ${cur}/${totalPages} (${list.length} total)`,
      `<i>✅ = asli OTP de chuka (sabse pehle). ⛔ = pool load hota hai par OTP nahi deta (45m demote). Fail/empty DBs 30m quarantine me.</i>`,
      '',
    ];
    if (!slice.length) {
      lines.push('<i>Koi Firebase source nahi hai — ➕ Add Firebase (Bulk) se add karo.</i>');
    } else {
      for (const s of slice) {
        const isQuar = Number(s.quarantinedUntil) > now;
        const otpDead = Number(s.otpQuarantinedUntil) > now;
        const otpProven = Number(s.otpOkCount) > 0;
        const killed = isQuar || otpDead;
        const icon = killed ? '⏳' : otpProven ? '✅' : s.lastOkAt > 0 ? '🟢' : s.failCount > 0 ? '❌' : '⚪';
        const star = s.primary ? '⭐ ' : '';
        const meta = otpDead
          ? `no OTP ${fmtDuration((s.otpQuarantinedUntil - now) / 1000)}`
          : isQuar
            ? `quar ${fmtDuration((s.quarantinedUntil - now) / 1000)}`
            : otpProven
              ? `OTP ✓${s.otpOkCount}${s.otpBestLatencyMs ? ` · ${(s.otpBestLatencyMs / 1000).toFixed(1)}s` : ''}`
              : s.latencyMs
                ? `pool ${s.latencyMs}ms`
                : 'untested';
        lines.push(`${icon} ${star}<b>${esc(s.name)}</b> · <code>${esc(meta)}</code>${s.hasAuth ? ' 🔐' : ''}`);
      }
    }

    const rows = [];
    for (let i = 0; i < slice.length; i += 2) {
      const pair = slice.slice(i, i + 2).map((s) =>
        Markup.button.callback(`${s.primary ? '⭐ ' : ''}${s.name.slice(0, 14)}`, `fb_src_view_${s.id}_${cur}`)
      );
      rows.push(pair);
    }

    const nav = [];
    if (cur > 1) nav.push(Markup.button.callback('⬅️ Prev', `fb_sources_page_${cur - 1}`));
    nav.push(Markup.button.callback('🔄', `fb_sources_page_${cur}`));
    if (cur < totalPages) nav.push(Markup.button.callback('Next ➡️', `fb_sources_page_${cur + 1}`));
    rows.push(nav);
    rows.push([
      Markup.button.callback('➕ Add Bulk', 'fb_src_add'),
      Markup.button.callback('🔥 FB Panel', 'act_fb_panel'),
    ]);

    return {
      text: lines.join('\n'),
      extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
    };
  }

  function buildFirebaseSourceDetail(id, backPage = 1, verifyNote = '') {
    const s = db.getFirebaseSource(id);
    if (!s) {
      return {
        text: '❌ Firebase source nahi mila.',
        extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `fb_sources_page_${backPage}`)]]) },
      };
    }
    const now = Date.now();
    const isQuar = Number(s.quarantinedUntil) > now;
    const lines = [
      `🔥 <b>FIREBASE SOURCE — ${esc(s.name)}</b>`,
      `🔗 <code>${esc(s.url)}</code>`,
      `⭐ Primary: <b>${s.primary ? 'YES' : 'NO'}</b> · 🔐 Auth: <b>${s.hasAuth ? 'SET' : 'Open/None'}</b>`,
      `🩺 Health: <b>${isQuar ? `Quarantined (${fmtDuration((s.quarantinedUntil - now) / 1000)} left)` : s.lastOkAt > 0 ? 'LIVE ✅' : 'Untested'}</b>`,
      `📊 OK: <code>${s.okCount}</code> · Fail: <code>${s.failCount}</code> · Latency: <code>${s.latencyMs || 0}ms</code>`,
      s.lastError ? `⚠️ Last error: <code>${esc(s.lastError)}</code>` : '',
      verifyNote ? `\n${verifyNote}` : '',
    ].filter(Boolean);

    const rows = [
      [
        Markup.button.callback('⭐ Set First-Try', `fb_src_primary_${s.id}_${backPage}`),
        Markup.button.callback('🧪 Verify Now', `fb_src_verify_${s.id}_${backPage}`),
      ],
      [
        Markup.button.callback('🗑 Delete Source', `fb_src_del_${s.id}_${backPage}`),
        Markup.button.callback('⬅️ Back', `fb_sources_page_${backPage}`),
      ],
    ];

    return {
      text: lines.join('\n'),
      extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
    };
  }

  // ── Settings View ──────────────────────────────────────────────────────────
  function buildSettingsView() {
    const cfg = getRuntimeConfig();
    const accounts = db.listAccounts({ includeSession: false });
    const fbHealth = db.getFirebaseHealthSummary();
    const botDist = { hathi: 0, hermes: 0, chauhan: 0 };
    for (const acc of accounts) {
      const pid = normalizeOtpBotProfileId(acc.otpBotProfile);
      botDist[pid] = (botDist[pid] || 0) + 1;
    }
    const maskedKeys = cfg.toingAccessKeys.map((k) => k.length > 8 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k).join(', ');
    const lines = [
      `⚙️ <b>TOING CLUSTER SETTINGS</b>`,
      ``,
      `🔥 Firebase Fresh-Only Mode: <b>${cfg.firebaseMode ? `ON ✅ (${fbHealth.total} DBs, Already-Reg AUTO SKIP)` : `OFF (${fbHealth.total} DBs ready)`}</b>`,
      `🆕 TG Bot Skip Registered: <b>${cfg.skipRegistered === true ? 'ON (Fresh Only)' : 'OFF ✅ (New + Registered Sab Par OTP)'}</b>`,
      `🤖 Default OTP Bot: <code>${esc(cfg.defaultOtpBot)}</code> (🐘 ${botDist.hathi} | 📨 ${botDist.hermes} | 🔐 ${botDist.chauhan})`,
      `🔁 Auto-Failover & Pool Rotate: <b>${cfg.autoFailoverBots ? `ON (every ${cfg.poolRotateThreshold || 12} skips)` : 'OFF'}</b>`,
      `⏱ OTP Fast-Fail Timeout: <code>${Math.round(cfg.otpTimeoutMs / 1000)}s</code> (FB: <code>${Math.round(cfg.firebaseOtpTimeoutMs / 1000)}s</code>)`,
      `🚦 Toing HTTP Concurrency: <code>${cfg.toingHttpConcurrency}</code>`,
      `🔑 Toing Access Keys (${cfg.toingAccessKeys.length}): <code>${esc(maskedKeys)}</code>`,
      `📤 Delivery Chat: <code>${esc(cfg.deliveryChatId || cfg.primaryOwnerId || 'owner DM')}</code>`,
      `🔄 Auto-Resume on Restart: <b>${cfg.autoResume ? 'ON' : 'OFF'}</b>`,
      ``,
      `<i>Commands:</i>`,
      `• <code>/firebase</code> — 🔥 Firebase Fresh-Only mode &amp; 400+ DB sources control`,
      `• <code>/cooldowns</code> — Cooldown pool breakdown &amp; clear controls`,
      `• <code>/logs</code> — Har number ka skip/drop/success exact reason dekho`,
      `• <code>/spreadbots</code> — Saare slots ko 3 OTP bots me equally spread karo`,
      `• <code>/setkey KEY1,KEY2</code> — Update Toing keys live`,
      `• <code>/setchat -100123...</code> — Set delivery chat (or <code>/setchat here</code>)`,
      `• <code>/session 9876543210</code> — Fetch saved .json by phone`,
      `• <code>/retry_deliveries</code> — Retry any failed file deliveries`,
    ];

    const rows = [
      [
        Markup.button.callback(
          cfg.firebaseMode ? '🔥 Firebase Mode: ON ✅' : '🔥 Firebase Mode: OFF',
          'act_toggle_fb_mode'
        ),
        Markup.button.callback(`🔥 FB Sources (${fbHealth.total})`, 'act_fb_panel'),
      ],
      [
        Markup.button.callback(
          `🆕 Skip Registered: ${cfg.skipRegistered === true ? 'ON' : 'OFF ✅'}`,
          'cfg_toggle_skip_reg'
        ),
        Markup.button.callback('🔀 Spread 3 Bots', 'cfg_spread_bots'),
      ],
      [
        Markup.button.callback('🐘 All → Hathi', 'cfg_allbot_hathi'),
        Markup.button.callback('📨 All → Hermes', 'cfg_allbot_hermes'),
        Markup.button.callback('🔐 All → HardX', 'cfg_allbot_chauhan'),
      ],
      [
        Markup.button.callback(`⏱ 20s`, 'cfg_otp_20000'),
        Markup.button.callback(`⏱ 26s`, 'cfg_otp_26000'),
        Markup.button.callback(`⏱ 30s`, 'cfg_otp_30000'),
        Markup.button.callback(`⏱ 40s`, 'cfg_otp_40000'),
      ],
      [
        Markup.button.callback('🚦 HTTP 15', 'cfg_http_15'),
        Markup.button.callback('🚦 HTTP 20', 'cfg_http_20'),
        Markup.button.callback('🚦 HTTP 30', 'cfg_http_30'),
        Markup.button.callback('🚦 HTTP 40', 'cfg_http_40'),
      ],
      [
        Markup.button.callback(`🔁 Failover: ${cfg.autoFailoverBots ? 'ON' : 'OFF'}`, 'cfg_toggle_failover'),
        Markup.button.callback(`🔄 AutoResume: ${cfg.autoResume ? 'ON' : 'OFF'}`, 'cfg_toggle_resume'),
      ],
      [
        Markup.button.callback('🔑 Set Toing Key', 'cfg_prompt_key'),
        Markup.button.callback('🏠 Dashboard', 'act_dash'),
      ],
    ];

    return {
      text: lines.join('\n'),
      extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
    };
  }

  // ── Commands ───────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    chatModes.delete(String(ctx.chat.id));
    // Auto-record primary delivery chat if none set yet
    if (!db.getSetting('deliveryChatId') && !getRuntimeConfig().deliveryChatId) {
      db.setSetting('deliveryChatId', String(ctx.chat.id));
    }
    const { text, extra } = buildDashboard();
    await ctx.reply(text, extra);
  });

  bot.command(['status', 'stats'], async (ctx) => {
    const { text, extra } = buildDashboard();
    await ctx.reply(text, extra);
  });

  bot.command(['firebase', 'fb'], async (ctx) => {
    const { text, extra } = buildFirebasePanelView();
    await ctx.reply(text, extra);
  });

  bot.command(['logs', 'log', 'reasons'], async (ctx) => {
    const limit = Math.min(40, Math.max(5, Number((ctx.message.text || '').split(/\s+/)[1]) || 22));
    const { text, extra } = buildNumberLogView(limit);
    await ctx.reply(text, extra);
  });

  bot.command(['cooldowns', 'cooldown'], async (ctx) => {
    const { text, extra } = buildCooldownsView();
    await ctx.reply(text, extra);
  });

  bot.command('slots', async (ctx) => {
    const page = Number((ctx.message.text || '').split(/\s+/)[1]) || 1;
    const { text, extra } = buildSlotsPage(page);
    await ctx.reply(text, extra);
  });

  bot.command('startall', async (ctx) => {
    const cfg = getRuntimeConfig();
    if (cfg.firebaseMode && firebaseManager) {
      const res = await firebaseManager.start();
      if (!res.ok) {
        await ctx.reply('⚠️ Koi Firebase source nahi hai — pehle <code>/firebase</code> se URL add karo.', { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`🔥 Started <b>Firebase Fresh-Only Mode</b> (${res.lanes} parallel lanes, ${res.totalSources} sources — Already-Registered AUTO SKIP ✅).`, { parse_mode: 'HTML' });
      }
    } else {
      const res = await slotManager.startAll();
      await ctx.reply(`🚀 Started <b>${res.started}</b> slots (total enabled: ${res.totalEnabled}${res.skippedDead ? `, skipped dead: ${res.skippedDead}` : ''}).`, { parse_mode: 'HTML' });
    }
    const { text, extra } = buildDashboard();
    await ctx.reply(text, extra);
  });

  bot.command('stopall', async (ctx) => {
    const [tgRes] = await Promise.all([
      slotManager.stopAll({ gracefulMs: 15_000, persistStopped: true }),
      firebaseManager ? firebaseManager.stop({ gracefulMs: 15_000, persistStopped: true }) : Promise.resolve(),
    ]);
    await ctx.reply(`🛑 Stopped cleanly (TG slots stopped: <b>${tgRes.stopped}</b>, Firebase stopped).`, { parse_mode: 'HTML' });
  });

  bot.command('resethealth', async (ctx) => {
    const count = db.resetAllAccountHealth();
    slotManager.wakeCooldownSlots();
    await ctx.reply(`♻️ Reset health/cooldown on <b>${count}</b> slots.`, { parse_mode: 'HTML' });
    if (slotManager.desiredRunning) {
      await slotManager.startAll();
    }
  });

  bot.command('setbot', async (ctx) => {
    const arg = (ctx.message.text || '').split(/\s+/)[1] || '';
    if (!arg) {
      await ctx.reply('Usage: <code>/setbot hathi</code> | <code>/setbot hermes</code> | <code>/setbot chauhan</code>', { parse_mode: 'HTML' });
      return;
    }
    const profile = normalizeOtpBotProfileId(arg);
    db.setSetting('defaultOtpBot', profile);
    const res = slotManager.setAllSlotsOtpBot(profile);
    await ctx.reply(`🤖 Default + all <b>${res.updated}</b> slots switched to <b>${esc(OTP_BOT_PROFILES[profile].uiLabel)}</b>.`, { parse_mode: 'HTML' });
  });

  bot.command('spreadbots', async (ctx) => {
    const res = slotManager.spreadSlotsAcrossBots();
    const d = res.distribution || {};
    await ctx.reply(
      `🔀 Spread <b>${res.updated}</b> slots across all 3 OTP bots:\n🐘 Hathi: <b>${d.hathi || 0}</b> | 📨 Hermes: <b>${d.hermes || 0}</b> | 🔐 HardX: <b>${d.chauhan || 0}</b>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('setkey', async (ctx) => {
    const raw = (ctx.message.text || '').replace(/^\/setkey\s*/i, '').trim();
    if (!raw) {
      await ctx.reply('Usage: <code>/setkey TNG-XXXX-XXXX-XXXX</code> (comma-separated multiple keys supported)', { parse_mode: 'HTML' });
      return;
    }
    const keys = parseCsvList(raw);
    if (!keys.length) return;
    db.setSetting('toingAccessKeys', keys);
    await ctx.reply(`🔑 Saved <b>${keys.length}</b> Toing Access Key(s) live (round-robin active).`, { parse_mode: 'HTML' });
  });

  bot.command('setchat', async (ctx) => {
    const arg = (ctx.message.text || '').split(/\s+/)[1] || 'here';
    const target = arg.toLowerCase() === 'here' ? String(ctx.chat.id) : arg.trim();
    db.setSetting('deliveryChatId', target);
    await ctx.reply(`📤 Exported <code>.json</code> delivery chat set to: <code>${esc(target)}</code>`, { parse_mode: 'HTML' });
  });

  bot.command('retry_deliveries', async (ctx) => {
    const cfg = getRuntimeConfig();
    const count = db.requeueFailedDeliveries(cfg.deliveryChatId || String(ctx.chat.id));
    await ctx.reply(`📤 Re-queued <b>${count}</b> failed deliveries.`, { parse_mode: 'HTML' });
  });

  bot.command('session', async (ctx) => {
    const phone = (ctx.message.text || '').split(/\s+/)[1] || '';
    const row = db.getSessionByPhone(phone);
    if (!row) {
      await ctx.reply(`❌ Phone <code>${esc(phone)}</code> ka koi saved session nahi mila.`, { parse_mode: 'HTML' });
      return;
    }
    await ctx.replyWithDocument({
      source: Buffer.from(row.raw_json, 'utf8'),
      filename: row.file_name || `toing-${row.mobile}.json`,
    }, {
      caption: `📦 Saved Toing session for <code>${esc(row.mobile)}</code>`,
      parse_mode: 'HTML',
    });
  });

  bot.command('sessions', async (ctx) => {
    const limit = Math.min(2000, Math.max(1, Number((ctx.message.text || '').split(/\s+/)[1]) || 50));
    await sendSessionsBundle(ctx, limit);
  });

  bot.command('import', async (ctx) => {
    chatModes.set(String(ctx.chat.id), { type: 'import' });
    await ctx.reply([
      `📥 <b>BULK IMPORT SPARE TELEGRAM ACCOUNTS (Up to 50)</b>`,
      ``,
      `Paste 1–50 lines (ya <code>.txt</code> / <code>.json</code> file bhejo). Security ke liye aapka message turant delete kar diya jayega:`,
      ``,
      `<b>Supported formats:</b>`,
      `• <code>1BVtsOHw...</code> (ek line = ek StringSession)`,
      `• <code>acc1|1BVtsOHw...</code> (label + session)`,
      `• <code>acc1|hathi|1BVtsOHw...</code> (label + otpBot + session)`,
      `• JSON array: <code>[{"label":"acc1","otpBot":"hathi","session":"1BV..."}]</code>`,
      ``,
      `Cancel karne ke liye <code>/cancel</code> bhejo.`,
    ].join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('addaccount', async (ctx) => {
    await startInteractivePhoneLogin(ctx);
  });

  bot.command(['addqr', 'qr'], async (ctx) => {
    await startQrLogin(ctx);
  });

  function abortChatFlow(chatId) {
    const key = String(chatId);
    const mode = chatModes.get(key);
    if (mode?.type === 'login') {
      mode.cancelled = true;
      try { mode.abortController?.abort(); } catch {}
      mode.rejectInput?.(new Error('Cancelled by user'));
    }
    chatModes.delete(key);
  }

  bot.command('cancel', async (ctx) => {
    abortChatFlow(ctx.chat.id);
    await ctx.reply('✅ Cancelled.');
  });

  // ── Helper: Send combined recent sessions JSON bundle ──────────────────────
  async function sendSessionsBundle(ctx, limit = 50) {
    const rows = db.getRecentSessions(limit);
    if (!rows.length) {
      await ctx.reply('📭 Abhi koi exported Toing session saved nahi hai.');
      return;
    }
    const list = rows.map((r) => {
      try { return JSON.parse(r.raw_json); } catch { return { mobile: r.mobile, token: r.token }; }
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await ctx.replyWithDocument({
      source: Buffer.from(JSON.stringify(list, null, 2), 'utf8'),
      filename: `toing-sessions-${list.length}-${stamp}.json`,
    }, {
      caption: `📦 Last <b>${list.length}</b> Toing sessions exported.`,
      parse_mode: 'HTML',
    });
  }

  // ── Shared Helper: Save & Auto-Start Newly Logged-In Account ───────────────
  async function saveLoggedInAccount(ctx, res) {
    const cfg = getRuntimeConfig();
    const added = db.addAccount({
      session: res.session,
      label: res.me ? res.me.split('·')[0].trim().slice(0, 24) : (res.phone || 'Spare'),
      tgUserLabel: res.me || res.phone || '',
      otpBotProfile: cfg.defaultOtpBot,
      maxSlots: cfg.maxSlots,
    });

    if (added.ok) {
      await ctx.reply([
        `✅ <b>Spare Account Added!</b>`,
        `🎛 Slot: <b>#${added.slotNo}</b> (${esc(added.label)})`,
        `👤 Account: <code>${esc(res.me || res.phone)}</code>`,
        `🤖 OTP Bot: <code>${esc(added.otpBotProfile)}</code>`,
      ].join('\n'), { parse_mode: 'HTML' });

      if (slotManager.desiredRunning) {
        await slotManager.startSlot(added.id);
        await ctx.reply(`🚀 Slot #${added.slotNo} auto-started in parallel cluster!`);
      }
    } else {
      await ctx.reply(`⚠️ Login OK, par save fail: <code>${esc(added.reason)}</code>`, { parse_mode: 'HTML' });
    }
  }

  // ── Helper: Interactive Phone Login Flow ───────────────────────────────────
  async function startInteractivePhoneLogin(ctx) {
    const cfg = getRuntimeConfig();
    if (!cfg.telegramApiId || !cfg.telegramApiHash) {
      await ctx.reply('❌ Railway env me <code>TELEGRAM_API_ID</code> aur <code>TELEGRAM_API_HASH</code> pehle set karo (my.telegram.org).', { parse_mode: 'HTML' });
      return;
    }
    const chatId = String(ctx.chat.id);
    if (chatModes.get(chatId)?.type === 'login') {
      await ctx.reply('⏳ Ek account login pehle se chal raha hai — pehle complete ya /cancel karo.');
      return;
    }

    const flow = {
      type: 'login',
      cancelled: false,
      resolveInput: null,
      rejectInput: null,
      resendFn: null,
      nextType: '',
    };
    chatModes.set(chatId, flow);

    const ask = async (promptHtml, buttons = [[Markup.button.callback('❌ Cancel', 'act_login_cancel')]]) => {
      if (flow.cancelled) throw new Error('Cancelled');
      await ctx.reply(promptHtml, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons),
      });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          flow.resolveInput = null;
          flow.rejectInput = null;
          reject(new Error('Login input timeout (3 min)'));
        }, 180_000);
        flow.resolveInput = (val) => { clearTimeout(timer); flow.resolveInput = null; flow.rejectInput = null; resolve(val); };
        flow.rejectInput = (err) => { clearTimeout(timer); flow.resolveInput = null; flow.rejectInput = null; reject(err); };
      });
    };

    // Run login in background so Telegraf update loop stays completely non-blocking!
    (async () => {
      try {
        const res = await loginInteractiveSession({
          apiId: cfg.telegramApiId,
          apiHash: cfg.telegramApiHash,
          forceSMS: false,
          shouldAbort: () => flow.cancelled,
          callbacks: {
            phoneNumber: () => ask([
              `📱 Spare Telegram account ka <b>phone number</b> bhejo (e.g. <code>+919876543210</code>)`,
              `<i>Tip: Agar account phone par Telegram app me login hai to code 1 sec me Telegram app me aayega (ya <b>/addqr</b> se seedha QR scan kar lo).</i>`,
            ].join('\n')),
            phoneCode: (_isCodeViaApp, info) => {
              const summary = formatCodeDeliverySummary(info);
              flow.resendFn = typeof info?.resend === 'function' ? info.resend : null;
              flow.nextType = summary.nextType;
              const btns = [];
              if (flow.resendFn && summary.nextType) {
                btns.push([Markup.button.callback(`🔄 Resend via ${summary.nextType.toUpperCase()}`, 'act_login_resend')]);
              }
              btns.push([
                Markup.button.callback('📷 Switch to QR Login', 'act_login_switch_qr'),
                Markup.button.callback('❌ Cancel', 'act_login_cancel'),
              ]);
              return ask([
                summary.channelLine,
                ``,
                `🔑 <b>Login code yahan reply karo</b> (space daal ke bhi chalega, e.g. <code>1 2 3 4 5</code>):`,
                summary.tipLine,
              ].join('\n'), btns);
            },
            emailVerification: (emailInfo) => ask(
              `📧 Telegram ne email verification code bheja hai${emailInfo?.emailPattern ? ` (<code>${esc(emailInfo.emailPattern)}</code>)` : ''}. Email code bhejo:`
            ),
            password: (hint) => ask(`🔐 Is account par 2FA ON hai${hint ? ` (hint: <code>${esc(hint)}</code>)` : ''}. <b>2FA password</b> bhejo:`),
            onError: async (err) => {
              await ctx.reply(`⚠️ Telegram login error: <code>${esc(String(err?.message || err).slice(0, 180))}</code>`, { parse_mode: 'HTML' }).catch(() => {});
              return false;
            },
          },
        });

        await saveLoggedInAccount(ctx, res);
      } catch (err) {
        if (!flow.cancelled) {
          await ctx.reply(`❌ Account login fail: <code>${esc(String(err?.message || err).slice(0, 180))}</code>`, { parse_mode: 'HTML' }).catch(() => {});
        }
      } finally {
        if (chatModes.get(chatId) === flow) chatModes.delete(chatId);
      }
    })();
  }

  // ── Helper: QR Code Login Flow (Zero SMS/OTP issues!) ──────────────────────
  async function startQrLogin(ctx) {
    const cfg = getRuntimeConfig();
    if (!cfg.telegramApiId || !cfg.telegramApiHash) {
      await ctx.reply('❌ Railway env me <code>TELEGRAM_API_ID</code> aur <code>TELEGRAM_API_HASH</code> pehle set karo (my.telegram.org).', { parse_mode: 'HTML' });
      return;
    }
    const chatId = String(ctx.chat.id);
    if (chatModes.get(chatId)?.type === 'login') {
      await ctx.reply('⏳ Ek account login pehle se chal raha hai — pehle complete ya /cancel karo.');
      return;
    }

    const abortController = new AbortController();
    const flow = {
      type: 'login',
      cancelled: false,
      abortController,
      resolveInput: null,
      rejectInput: null,
    };
    chatModes.set(chatId, flow);

    const overallTimeout = setTimeout(() => {
      if (!flow.cancelled) {
        flow.cancelled = true;
        try { abortController.abort(); } catch {}
        ctx.reply('⏱ QR login timeout (2 min) — dobara try karne ke liye /addqr bhejo.').catch(() => {});
      }
    }, 120_000);

    let lastQrMsgId = 0;

    (async () => {
      try {
        const res = await loginQrSession({
          apiId: cfg.telegramApiId,
          apiHash: cfg.telegramApiHash,
          abortSignal: abortController.signal,
          callbacks: {
            qrCode: async ({ url }) => {
              if (flow.cancelled) return;
              const pngBuf = await QRCode.toBuffer(url, { width: 320, margin: 2 });
              if (lastQrMsgId) {
                await ctx.telegram.deleteMessage(ctx.chat.id, lastQrMsgId).catch(() => {});
              }
              const sent = await ctx.replyWithPhoto(
                { source: pngBuf, filename: 'telegram-qr-login.png' },
                {
                  caption: [
                    `📷 <b>QR LOGIN — ZERO OTP NEEDED!</b>`,
                    ``,
                    `1️⃣ Spare Telegram app kholo`,
                    `2️⃣ <b>Settings → Devices → Link Desktop Device</b>`,
                    `3️⃣ Ye QR scan karo (30s me auto-refresh hota hai)`,
                  ].join('\n'),
                  parse_mode: 'HTML',
                  ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'act_login_cancel')]]),
                }
              );
              lastQrMsgId = sent?.message_id || 0;
            },
            password: async (hint) => {
              if (flow.cancelled) throw new Error('Cancelled');
              await ctx.reply(
                `🔐 QR scan OK! Is account par 2FA ON hai${hint ? ` (hint: <code>${esc(hint)}</code>)` : ''}. <b>2FA password</b> bhejo:`,
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'act_login_cancel')]]) }
              );
              return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  flow.resolveInput = null;
                  flow.rejectInput = null;
                  reject(new Error('2FA input timeout'));
                }, 120_000);
                flow.resolveInput = (val) => { clearTimeout(timer); flow.resolveInput = null; flow.rejectInput = null; resolve(val); };
                flow.rejectInput = (err) => { clearTimeout(timer); flow.resolveInput = null; flow.rejectInput = null; reject(err); };
              });
            },
            onError: async (err) => {
              await ctx.reply(`⚠️ QR login error: <code>${esc(String(err?.message || err).slice(0, 180))}</code>`, { parse_mode: 'HTML' }).catch(() => {});
              return false;
            },
          },
        });

        if (lastQrMsgId) {
          await ctx.telegram.deleteMessage(ctx.chat.id, lastQrMsgId).catch(() => {});
        }
        await saveLoggedInAccount(ctx, res);
      } catch (err) {
        if (!flow.cancelled && err?.name !== 'AbortError') {
          await ctx.reply(`❌ QR login fail: <code>${esc(String(err?.message || err).slice(0, 180))}</code>`, { parse_mode: 'HTML' }).catch(() => {});
        }
      } finally {
        clearTimeout(overallTimeout);
        if (chatModes.get(chatId) === flow) chatModes.delete(chatId);
      }
    })();
  }

  // ── Callback Actions ───────────────────────────────────────────────────────
  bot.action('act_dash', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const { text, extra } = buildDashboard();
    await editOrReply(ctx, text, extra);
  });

  bot.action('act_start_all', async (ctx) => {
    await ctx.answerCbQuery('🚀 Starting slots...').catch(() => {});
    const res = await slotManager.startAll();
    const { text, extra } = buildDashboard();
    await editOrReply(ctx, text, extra);
    if (res.totalEnabled === 0) {
      await ctx.reply('⚠️ Koi enabled spare TG account nahi mila — pehle <b>Bulk Import</b> ya <b>Add via Phone</b> se accounts add karo.', { parse_mode: 'HTML' });
    }
  });

  bot.action('act_stop_all', async (ctx) => {
    await ctx.answerCbQuery('🛑 Stopping slots cleanly...').catch(() => {});
    await slotManager.stopAll({ gracefulMs: 15_000, persistStopped: true });
    const { text, extra } = buildDashboard();
    await editOrReply(ctx, text, extra);
  });

  // ── 🔥 Firebase Fresh-Only Mode & Source Callbacks ────────────────────────
  bot.action('act_toggle_fb_mode', async (ctx) => {
    const next = !getRuntimeConfig().firebaseMode;
    await ctx.answerCbQuery(
      next ? '🔥 Firebase Fresh-Only Mode ON (Already-Reg Auto Skip)' : '🤖 Switched back to Telegram OTP Bot Mode'
    ).catch(() => {});
    const res = await switchFirebaseMode(next);
    const { text, extra } = buildDashboard();
    await editOrReply(ctx, text, extra);
    if (next && res.reason === 'no_sources') {
      await ctx.reply('⚠️ Koi Firebase source nahi hai — pehle <b>🔥 FB Panel → ➕ Add Firebase (Bulk)</b> se URL add karo.', { parse_mode: 'HTML' });
    }
  });

  bot.action('act_fb_panel', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const { text, extra } = buildFirebasePanelView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('act_fb_start', async (ctx) => {
    if (!firebaseManager) {
      await ctx.answerCbQuery('❌ Firebase engine unavailable', { show_alert: true }).catch(() => {});
      return;
    }
    await ctx.answerCbQuery('🔥 Starting Firebase Fresh-Only Mode...').catch(() => {});
    db.setSetting('firebaseMode', true);
    if (slotManager.desiredRunning || slotManager.getDashboardSnapshot().runningCount > 0) {
      await slotManager.stopAll({ gracefulMs: 10_000, persistStopped: false });
    }
    const res = await firebaseManager.start();
    const { text, extra } = buildDashboard();
    await editOrReply(ctx, text, extra);
    if (!res.ok) {
      await ctx.reply('⚠️ Koi Firebase source nahi hai — pehle <b>🔥 FB Panel → ➕ Add Firebase (Bulk)</b> se DB URL daalo.', { parse_mode: 'HTML' });
    }
  });

  bot.action('act_fb_stop', async (ctx) => {
    await ctx.answerCbQuery('🛑 Stopping Firebase lanes...').catch(() => {});
    if (firebaseManager) {
      await firebaseManager.stop({ gracefulMs: 15_000, persistStopped: true });
    }
    const { text, extra } = buildDashboard();
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^fb_lanes_(\d+)$/, async (ctx) => {
    const lanes = Math.max(1, Math.min(30, Number(ctx.match[1]) || 12));
    db.setSetting('firebaseConcurrency', lanes);
    await ctx.answerCbQuery(`⚡ Firebase lanes -> ${lanes}`).catch(() => {});
    if (firebaseManager?.desiredRunning) {
      await firebaseManager.stop({ gracefulMs: 8_000, persistStopped: false });
      await firebaseManager.start();
    }
    const { text, extra } = buildFirebasePanelView();
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^fb_otp_(\d+)$/, async (ctx) => {
    const ms = Number(ctx.match[1]) || 60_000;
    db.setSetting('firebaseOtpTimeoutMs', ms);
    await ctx.answerCbQuery(`⏱ Firebase OTP timeout -> ${ms / 1000}s`).catch(() => {});
    const { text, extra } = buildFirebasePanelView();
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^fb_sources_page_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const { text, extra } = buildFirebaseSourcesPage(Number(ctx.match[1]));
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^fb_src_view_([a-zA-Z0-9_-]+)_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const { text, extra } = buildFirebaseSourceDetail(ctx.match[1], Number(ctx.match[2]));
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^fb_src_primary_([a-zA-Z0-9_-]+)_(\d+)$/, async (ctx) => {
    const id = ctx.match[1];
    const page = Number(ctx.match[2]);
    const res = db.setPrimaryFirebaseSource(id);
    if (res.ok) firebaseManager?.resetSourceRotation();
    await ctx.answerCbQuery(res.ok ? '⭐ Set as First-Try source!' : `❌ ${res.error}`).catch(() => {});
    const { text, extra } = buildFirebaseSourceDetail(id, page);
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^fb_src_verify_([a-zA-Z0-9_-]+)_(\d+)$/, async (ctx) => {
    const id = ctx.match[1];
    const page = Number(ctx.match[2]);
    const src = db.getFirebaseSource(id);
    if (!src) {
      await ctx.answerCbQuery('❌ Source nahi mila').catch(() => {});
      return;
    }
    await ctx.answerCbQuery('🧪 Verifying Firebase DB...').catch(() => {});
    const v = await verifyFirebaseSource(src);
    db.recordFirebaseSourceResult(id, v.ok ? { ok: true, ms: v.ms } : { ok: false, error: v.error, ms: v.ms });
    const note = v.ok
      ? `✅ <b>Reachable</b> (${v.ms}ms) · keys: <code>${esc((v.topKeys || []).join(', ') || 'empty')}</code>`
      : `❌ <b>Verify Failed:</b> <code>${esc(v.error)}</code>`;
    const { text, extra } = buildFirebaseSourceDetail(id, page, note);
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^fb_src_del_([a-zA-Z0-9_-]+)_(\d+)$/, async (ctx) => {
    const id = ctx.match[1];
    const page = Number(ctx.match[2]);
    db.removeFirebaseSource(id);
    firebaseManager?.resetSourceRotation();
    await ctx.answerCbQuery('🗑 Firebase source deleted').catch(() => {});
    const { text, extra } = buildFirebaseSourcesPage(page);
    await editOrReply(ctx, text, extra);
  });

  bot.action('fb_src_add', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    chatModes.set(String(ctx.chat.id), { type: 'fb_add' });
    await ctx.reply([
      `➕ <b>ADD FIREBASE SOURCES (Bulk — up to 1000 URLs)</b>`,
      ``,
      `1 ya multiple Firebase Realtime DB URLs paste karo (ya <code>.txt</code> file bhejo):`,
      `• <code>https://xxxx-default-rtdb.firebaseio.com</code>`,
      `• <code>xxxx-default-rtdb.firebaseio.com</code> (https auto-add)`,
      `• Auth secret ke sath: <code>https://xxxx.firebaseio.com | YOUR_DB_SECRET</code>`,
      ``,
      `<i>Cancel: /cancel</i>`,
    ].join('\n'), { parse_mode: 'HTML' });
  });

  bot.action('fb_src_reset_health', async (ctx) => {
    const count = db.resetFirebaseSourceHealth();
    firebaseManager?.resetSourceRotation();
    await ctx.answerCbQuery(`♻️ Reset health on ${count} Firebase source(s)`).catch(() => {});
    const { text, extra } = buildFirebasePanelView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('fb_src_del_all_ask', async (ctx) => {
    await ctx.answerCbQuery('Tap YES to delete ALL Firebase sources').catch(() => {});
    const { text, extra } = buildFirebasePanelView({ confirmDeleteAll: true });
    await editOrReply(ctx, text, extra);
  });

  bot.action('fb_src_del_all_yes', async (ctx) => {
    if (firebaseManager?.desiredRunning) {
      await firebaseManager.stop({ gracefulMs: 10_000, persistStopped: true });
    }
    const res = db.removeAllFirebaseSources();
    await ctx.answerCbQuery(`🗑 Deleted ${res.removed} Firebase source(s)`).catch(() => {});
    const { text, extra } = buildFirebasePanelView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('act_import', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    chatModes.set(String(ctx.chat.id), { type: 'import' });
    await ctx.reply([
      `📥 <b>BULK IMPORT (1–50 StringSessions)</b>`,
      `Paste sessions (1 per line, ya <code>label|session</code>, ya <code>label|hathi|session</code>) ya <code>.txt</code>/<code>.json</code> file upload karo.`,
      `<i>Aapka message turant delete kar diya jayega. Cancel: /cancel</i>`,
    ].join('\n'), { parse_mode: 'HTML' });
  });

  bot.action('act_add_phone', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await startInteractivePhoneLogin(ctx);
  });

  bot.action('act_add_qr', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await startQrLogin(ctx);
  });

  bot.action('act_login_cancel', async (ctx) => {
    await ctx.answerCbQuery('Cancelled').catch(() => {});
    abortChatFlow(ctx.chat.id);
    await ctx.reply('✅ Login cancelled.');
  });

  bot.action('act_login_switch_qr', async (ctx) => {
    await ctx.answerCbQuery('Switching to QR...').catch(() => {});
    abortChatFlow(ctx.chat.id);
    await startQrLogin(ctx);
  });

  bot.action('act_login_resend', async (ctx) => {
    const flow = chatModes.get(String(ctx.chat.id));
    if (!flow || flow.type !== 'login' || typeof flow.resendFn !== 'function') {
      await ctx.answerCbQuery('Resend available nahi hai abhi.', { show_alert: true }).catch(() => {});
      return;
    }
    await ctx.answerCbQuery('🔄 Resending code...').catch(() => {});
    try {
      const nextInfo = await flow.resendFn();
      const summary = formatCodeDeliverySummary(nextInfo);
      flow.resendFn = typeof nextInfo?.resend === 'function' ? nextInfo.resend : null;
      flow.nextType = summary.nextType;
      await ctx.reply([
        `🔄 <b>Code Resent!</b>`,
        summary.channelLine,
        summary.tipLine,
      ].join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`⚠️ Resend fail: <code>${esc(String(err?.message || err).slice(0, 160))}</code>\n<i>Tip: /addqr se QR login use karo (zero SMS needed).</i>`, { parse_mode: 'HTML' });
    }
  });

  bot.action('act_logs', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const { text, extra } = buildNumberLogView(22);
    await editOrReply(ctx, text, extra);
  });

  bot.action('act_cooldowns', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const { text, extra } = buildCooldownsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('cool_clear_temp', async (ctx) => {
    const removed = db.clearCooldownsByStatus(['otp_timeout_cool', 'send_otp_blocked']);
    slotManager.clearAllLocalExcludes();
    await ctx.answerCbQuery(`🧹 Cleared ${removed} temp cooldown(s)`).catch(() => {});
    const { text, extra } = buildCooldownsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('cool_clear_reg', async (ctx) => {
    const removed = db.clearCooldownsByStatus(['already_registered']);
    slotManager.clearAllLocalExcludes();
    await ctx.answerCbQuery(`🚫 Cleared ${removed} already_registered`).catch(() => {});
    const { text, extra } = buildCooldownsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('cool_clear_seed', async (ctx) => {
    const removed = db.clearCooldownsByStatus(['seed']);
    db.setSetting('skipSeedOnBoot', true);
    slotManager.clearAllLocalExcludes();
    await ctx.answerCbQuery(`📦 Cleared ${removed} seed number(s)`).catch(() => {});
    const { text, extra } = buildCooldownsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('cool_clear_all_ask', async (ctx) => {
    await ctx.answerCbQuery('Confirm to clear ALL number cooldowns').catch(() => {});
    const { text, extra } = buildCooldownsView({ confirmAll: true });
    await editOrReply(ctx, text, extra);
  });

  bot.action('cool_clear_all_yes', async (ctx) => {
    const removed = db.clearCooldownsByStatus('all');
    db.setSetting('skipSeedOnBoot', true);
    slotManager.clearAllLocalExcludes();
    await ctx.answerCbQuery(`🗑 Cleared ALL ${removed} cooldown(s)`).catch(() => {});
    const { text, extra } = buildCooldownsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('act_settings', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const { text, extra } = buildSettingsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('act_export_50', async (ctx) => {
    await ctx.answerCbQuery('📦 Exporting...').catch(() => {});
    await sendSessionsBundle(ctx, 50);
  });

  bot.action('act_reset_health', async (ctx) => {
    const count = db.resetAllAccountHealth();
    slotManager.wakeCooldownSlots();
    await ctx.answerCbQuery(`♻️ Reset ${count} slots`).catch(() => {});
    if (slotManager.desiredRunning) {
      await slotManager.startAll();
    }
    const { text, extra } = buildDashboard();
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^slots_page_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const { text, extra } = buildSlotsPage(Number(ctx.match[1]));
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^slot_view_(\d+)_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const { text, extra } = buildSlotDetail(Number(ctx.match[1]), Number(ctx.match[2]));
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^slot_start_(\d+)_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    const res = await slotManager.startSlot(id);
    await ctx.answerCbQuery(res.ok ? `▶️ Slot #${res.slotNo} started` : `❌ ${res.reason}`).catch(() => {});
    const { text, extra } = buildSlotDetail(id, page);
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^slot_stop_(\d+)_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    await slotManager.stopSlot(id, { disable: true });
    await ctx.answerCbQuery('⏹ Slot stopped & disabled').catch(() => {});
    const { text, extra } = buildSlotDetail(id, page);
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^slot_reset_(\d+)_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    db.resetAccountHealth(id);
    await ctx.answerCbQuery('♻️ Health reset').catch(() => {});
    const { text, extra } = buildSlotDetail(id, page);
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^slot_bot_(\d+)_([a-z]+)_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const pid = ctx.match[2];
    const page = Number(ctx.match[3]);
    slotManager.setSlotOtpBot(id, pid);
    await ctx.answerCbQuery(`🤖 Switched to ${pid}`).catch(() => {});
    const { text, extra } = buildSlotDetail(id, page);
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^slot_del_(\d+)_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    await slotManager.removeSlot(id);
    await ctx.answerCbQuery('🗑 Slot deleted').catch(() => {});
    const { text, extra } = buildSlotsPage(page);
    await editOrReply(ctx, text, extra);
  });

  bot.action('cfg_spread_bots', async (ctx) => {
    const res = slotManager.spreadSlotsAcrossBots();
    const d = res.distribution || {};
    await ctx.answerCbQuery(`🔀 Spread: 🐘${d.hathi || 0} 📨${d.hermes || 0} 🔐${d.chauhan || 0}`).catch(() => {});
    const { text, extra } = buildSettingsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^cfg_allbot_([a-z]+)$/, async (ctx) => {
    const pid = normalizeOtpBotProfileId(ctx.match[1]);
    db.setSetting('defaultOtpBot', pid);
    const res = slotManager.setAllSlotsOtpBot(pid);
    await ctx.answerCbQuery(`🤖 All ${res.updated} slots -> ${pid}`).catch(() => {});
    const { text, extra } = buildSettingsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^cfg_otp_(\d+)$/, async (ctx) => {
    const ms = Number(ctx.match[1]);
    db.setSetting('otpTimeoutMs', ms);
    await ctx.answerCbQuery(`⏱ OTP timeout -> ${ms / 1000}s`).catch(() => {});
    const { text, extra } = buildSettingsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action(/^cfg_http_(\d+)$/, async (ctx) => {
    const limit = Number(ctx.match[1]);
    db.setSetting('toingHttpConcurrency', limit);
    toingClient.setConcurrency(limit);
    await ctx.answerCbQuery(`🚦 HTTP concurrency -> ${limit}`).catch(() => {});
    const { text, extra } = buildSettingsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('cfg_toggle_skip_reg', async (ctx) => {
    const next = !(getRuntimeConfig().skipRegistered === true);
    db.setSetting('skipRegistered', next);
    if (!next) slotManager.clearAllLocalExcludes();
    await ctx.answerCbQuery(`🆕 Skip Registered: ${next ? 'ON' : 'OFF'}`).catch(() => {});
    const { text, extra } = buildSettingsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('cfg_toggle_failover', async (ctx) => {
    const next = !getRuntimeConfig().autoFailoverBots;
    db.setSetting('autoFailoverBots', next);
    await ctx.answerCbQuery(`🔁 Failover ${next ? 'ON' : 'OFF'}`).catch(() => {});
    const { text, extra } = buildSettingsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('cfg_toggle_resume', async (ctx) => {
    const next = !getRuntimeConfig().autoResume;
    db.setSetting('autoResume', next);
    await ctx.answerCbQuery(`🔄 AutoResume ${next ? 'ON' : 'OFF'}`).catch(() => {});
    const { text, extra } = buildSettingsView();
    await editOrReply(ctx, text, extra);
  });

  bot.action('cfg_prompt_key', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    chatModes.set(String(ctx.chat.id), { type: 'setkey' });
    await ctx.reply('🔑 Nayi <b>Toing Access Key</b> bhejo (multiple keys ke liye comma-separated).\n<i>Cancel: /cancel</i>', { parse_mode: 'HTML' });
  });

  // ── Shared Bulk Import Handler ─────────────────────────────────────────────
  async function handleBulkImportPayload(ctx, rawText) {
    const cfg = getRuntimeConfig();
    const parsed = parseBulkSessionsInput(rawText, { defaultOtpBot: cfg.defaultOtpBot });
    if (!parsed.length) {
      await ctx.reply('⚠️ Koi valid StringSession nahi mili. Dobara paste karo ya /cancel bhejo.');
      return;
    }
    const res = db.importAccountsBulk(parsed, {
      defaultOtpBot: cfg.defaultOtpBot,
      maxSlots: cfg.maxSlots,
    });
    chatModes.delete(String(ctx.chat.id));

    const lines = [
      `📥 <b>BULK IMPORT COMPLETE</b>`,
      `✅ Added: <b>${res.added.length}</b>`,
      res.duplicates.length ? `♻️ Skipped duplicates: <b>${res.duplicates.length}</b>` : '',
      res.invalid.length ? `❌ Invalid lines: <b>${res.invalid.length}</b>` : '',
      res.capped ? `⚠️ Max slot cap (${cfg.maxSlots}) reached — skipped: <b>${res.capped}</b>` : '',
    ].filter(Boolean);

    if (res.added.length > 0 && slotManager.desiredRunning) {
      await slotManager.startNewEnabledSlots();
      lines.push(`🚀 Naye slots parallel cluster me auto-start ho gaye!`);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    const dash = buildDashboard();
    await ctx.reply(dash.text, dash.extra);
  }

  // ── Shared Bulk Firebase URL Import Handler ────────────────────────────────
  async function handleBulkFirebaseAddPayload(ctx, rawText) {
    const res = db.addFirebaseSourcesBulk(rawText, { setFirstAsPrimary: false });
    chatModes.delete(String(ctx.chat.id));
    if (res.added.length > 0) {
      firebaseManager?.resetSourceRotation();
    }
    const lines = [
      `🔥 <b>FIREBASE SOURCES IMPORT</b>`,
      `Added databases: <b>${res.added.length}</b> · Saved databases: <b>${res.total}</b>`,
      !res.added.length && !res.duplicates.length && !res.invalid.length ? 'ℹ️ Koi source entry nahi mili.' : '',
      res.duplicates.length ? `♻️ Already present: <b>${res.duplicates.length}</b>` : '',
      res.invalid.length ? `❌ Invalid entries: <b>${res.invalid.length}</b>` : '',
    ].filter(Boolean);
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    const panel = buildFirebasePanelView();
    await ctx.reply(panel.text, panel.extra);
  }

  // ── Text & Document Input Handler ──────────────────────────────────────────
  bot.on('document', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const mode = chatModes.get(chatId);
    const doc = ctx.message.document;
    const name = String(doc.file_name || '').trim().toLowerCase();
    // This reserved filename is reporting-only, even while another prompt is open.
    // Never guess that an unsolicited attachment belongs in either worker import.
    const isReport = name === REPORT_FILE;
    if (isReport) {
      if (ctx.chat.type !== 'private' || !getRuntimeConfig().ownerIds.includes(String(ctx.from?.id))) {
        await ctx.reply('Number report sirf configured owner ki private chat mein accept hoti hai.');
        return;
      }
    } else if (mode?.type !== 'import' && mode?.type !== 'fb_add') {
      if (name.endsWith('.txt') || doc.mime_type === 'text/plain') {
        await ctx.reply('TXT import nahi hui: is chat mein koi file input pending nahi hai. File download nahi ki. Read-only number report ka format /firebase mein hai.');
      }
      return;
    }

    const file = await readTextDocument(ctx, { maxBytes: isReport ? 128 * 1024 : 1024 * 1024, fetchImpl });
    // Prompted uploads may contain secrets; don't echo their contents, even on error.
    await ctx.deleteMessage().catch(() => {});
    if (file.error) {
      await ctx.reply(`❌ File import nahi hui: ${file.error}`);
      return;
    }
    if (isReport) {
      const { counts, error } = parsePresenceReport(file.text);
      if (error) {
        await ctx.reply(`❌ Report save nahi hui: ${error}`);
        return;
      }
      const report = { ...counts, uploadedAt: Date.now() };
      try {
        db.setSetting(REPORT_KEY, report);
      } catch {
        await ctx.reply('❌ Report save nahi hui: storage error.');
        return;
      }
      await ctx.reply(`✅ Number report saved. Koi database add ya request queue nahi hui.\n${formatPresenceReport(report)}`, { parse_mode: 'HTML' });
      return;
    }
    if (chatModes.get(chatId) !== mode) {
      await ctx.reply('File import nahi hui: file padhte waqt input prompt band ya badal gaya.');
      return;
    }
    try {
      if (mode.type === 'fb_add') {
        await handleBulkFirebaseAddPayload(ctx, file.text);
      } else {
        await handleBulkImportPayload(ctx, file.text);
      }
    } catch {
      await ctx.reply('File padh li, lekin import result confirm nahi hua.');
    }
  });

  bot.on('text', async (ctx) => {
    const text = String(ctx.message.text || '').trim();
    if (!text || text.startsWith('/')) return;

    const chatId = String(ctx.chat.id);
    const mode = chatModes.get(chatId);
    if (!mode) return;

    if (mode.type === 'login' && mode.resolveInput) {
      // Delete sensitive OTP / 2FA messages
      await ctx.deleteMessage().catch(() => {});
      mode.resolveInput(text);
      return;
    }

    if (mode.type === 'import') {
      // Immediately delete user's StringSession message from Telegram chat!
      await ctx.deleteMessage().catch(() => {});
      await handleBulkImportPayload(ctx, text);
      return;
    }

    if (mode.type === 'fb_add') {
      if (text.includes('|') || /[?&]auth=/i.test(text)) {
        await ctx.deleteMessage().catch(() => {});
      }
      await handleBulkFirebaseAddPayload(ctx, text);
      return;
    }

    if (mode.type === 'setkey') {
      const keys = parseCsvList(text);
      if (!keys.length) {
        await ctx.reply('❌ Valid key nahi mili. Dobara bhejo ya /cancel.');
        return;
      }
      db.setSetting('toingAccessKeys', keys);
      chatModes.delete(chatId);
      await ctx.reply(`🔑 Saved <b>${keys.length}</b> Toing Access Key(s) live!`, { parse_mode: 'HTML' });
    }
  });
}
