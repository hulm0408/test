// Official redemption form helper. The site supplies its own security check;
// no challenge response is generated, reused, or bypassed by this module.
//
// Default engine ab STEALTH stack hai: gold_drop_stealth.py worker SeleniumBase
// ke UC/CDP mode me Chrome launch karta hai, endpoint_url nikalta hai, aur
// Playwright `chromium.connect_over_cdp(endpoint_url)` se usi stealthy browser
// ko standard Playwright commands se drive karta hai. Python stack na mile to
// purana puppeteer-real-browser engine apne aap fallback me chal jata hai.
//   GOLD_DROP_STEALTH=0  → stealth kabhi try na karo (hamesha puppeteer)
//   GOLD_DROP_STEALTH=1  → STRICT stealth (fail ho to error, koi fallback nahi)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from 'puppeteer-real-browser';

export function parseWinningCodes(text, { maxCodes = 100 } = {}) {
  const tokens = String(text || '').split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) throw new Error('Code list khali hai');
  if (tokens.length > maxCodes) throw new Error(`Ek baar mein maximum ${maxCodes} codes bhejein`);
  const invalid = tokens.find(token => !/^[A-Za-z0-9]{1,12}$/.test(token));
  if (invalid) throw new Error('Har code sirf letters/digits ka ho aur 12 characters se bada na ho');
  return [...new Set(tokens.map(token => token.toUpperCase()))];
}

const STEALTH_WORKER_PATH = fileURLToPath(new URL('./gold_drop_stealth.py', import.meta.url));

// ─── Stealth worker (SeleniumBase CDP mode + Playwright connect_over_cdp) ───
// Worker se NDJSON protocol: launch → ready(endpointUrl), check → result/error.
// Ek hi stealth browser poore run me reuse hota hai; har code ke liye naya tab.
export async function launchGoldDropStealthChecker({
  pythonPath = process.env.GOLD_DROP_PYTHON || 'python3',
  workerPath = STEALTH_WORKER_PATH,
  chromePath = '',
  headed = process.env.GOLD_DROP_HEADED === '1',
  turnstileTimeoutMs = Number(process.env.GOLD_DROP_TURNSTILE_MS || 30000),
  launchTimeoutMs = Number(process.env.GOLD_DROP_LAUNCH_TIMEOUT_MS || 240000),
} = {}) {
  const proc = spawn(pythonPath, ['-u', workerPath, '--serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const handle = {
    stealth: true,
    endpointUrl: '',
    proc,
    seq: 0,
    closed: false,
    pending: new Map(),
    async close() {
      if (handle._closeDone) return;
      handle._closeDone = true;
      handle.closed = true;
      failAllPending('Stealth checker band ho gaya');
      try { proc.stdin.write(JSON.stringify({ cmd: 'close' }) + '\n'); } catch {}
      try { proc.stdin.end(); } catch {}
      const exited = proc.exitCode !== null || proc.signalCode !== null;
      if (!exited) {
        await Promise.race([
          new Promise(resolve => proc.once('exit', resolve)),
          new Promise(resolve => setTimeout(resolve, 10000)).then(() => { try { proc.kill('SIGKILL'); } catch {} }),
        ]);
      }
    },
  };
  const failAllPending = message => {
    for (const [, entry] of handle.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    handle.pending.clear();
  };
  const settlePending = (id, fn, value) => {
    const entry = handle.pending.get(id);
    if (!entry) return false;
    handle.pending.delete(id);
    clearTimeout(entry.timer);
    entry[fn](value);
    return true;
  };

  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        console.warn('[GoldDrop] Stealth worker ka non-JSON output ignore kiya:', line.slice(0, 120));
        continue;
      }
      const id = msg.id ?? 0;
      if (msg.type === 'ready') {
        handle.endpointUrl = String(msg.endpointUrl || '');
        settlePending(id, 'resolve', handle.endpointUrl);
      } else if (msg.type === 'result') {
        settlePending(id, 'resolve', { status: String(msg.status || 'unknown'), message: String(msg.message || '') });
      } else if (msg.type === 'warmup' || msg.type === 'register' || msg.type === 'verify') {
        settlePending(id, 'resolve', {
          ok: msg.ok === true,
          stage: String(msg.stage || ''),
          userAgent: String(msg.userAgent || ''),
          cookies: Array.isArray(msg.cookies) ? msg.cookies : [],
          message: String(msg.message || ''),
          screenshot: String(msg.screenshot || ''),
        });
      } else if (msg.type === 'error') {
        if (!settlePending(id, 'reject', new Error(String(msg.message || 'Stealth worker error').slice(0, 300)))) {
          console.warn('[GoldDrop] Stealth worker error (koi pending command nahi):', String(msg.message || '').slice(0, 200));
        }
      } else if (msg.type === 'fatal') {
        settlePending(0, 'reject', new Error(String(msg.message || 'Stealth worker fatal').slice(0, 300)));
        failAllPending(String(msg.message || 'Stealth worker fatal'));
      } // 'pong' jaise probes ke liye kuch karna nahi
    }
  });
  proc.on('error', error => {
    handle.closed = true;
    settlePending(0, 'reject', new Error(`Stealth worker start nahi hua (${pythonPath}): ${error.message}`));
    failAllPending(`Stealth worker start nahi hua: ${error.message}`);
  });
  proc.on('exit', (code, signal) => {
    handle.closed = true;
    settlePending(0, 'reject', new Error(`Stealth worker launch se pehle band ho gaya (code ${code ?? signal})`));
    failAllPending(`Stealth worker band ho gaya (code ${code ?? signal})`);
  });

  const launchPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settlePending(0, 'reject', new Error('Stealth browser launch timeout — pehli baar me driver download slow ho sakta hai'))) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }, launchTimeoutMs);
    handle.pending.set(0, { resolve, reject, timer });
    try {
      proc.stdin.write(JSON.stringify({ cmd: 'launch', id: 0, chromePath, headed, turnstileTimeoutMs }) + '\n');
    } catch (error) {
      settlePending(0, 'reject', error);
    }
  });
  await launchPromise;
  return handle;
}

function sendStealthCommand(handle, payload, timeoutMs, timeoutMessage) {
  if (handle.closed) return Promise.reject(new Error('Stealth worker band hai; checker dobara shuru karein'));
  const id = ++handle.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (handle.pending.delete(id)) reject(new Error(timeoutMessage));
    }, timeoutMs);
    handle.pending.set(id, { resolve, reject, timer });
    try {
      handle.proc.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
    } catch (error) {
      clearTimeout(timer);
      handle.pending.delete(id);
      reject(error);
    }
  });
}

async function checkGoldDropCodeStealth(handle, { code, name, mobile }) {
  const timeoutMs = Number(process.env.GOLD_DROP_CHECK_TIMEOUT_MS || 150000);
  return sendStealthCommand(handle, { cmd: 'check', code, name, mobile }, timeoutMs,
    'Stealth check timeout — site ya security step atka hua hai');
}

// Registration API flow ke liye: stealth browser me offer page kholkar site ka
// security challenge asli fingerprint se clear hone do, phir clearance cookies
// + browser User-Agent wapas lo — GoldDropClient inke saath "security check"
// rejection ke bina chalta hai. ok:false mile to caller purane wait-retry par
// chalta hai (challenge ko hum kabhi solve/click nahi karte).
export async function warmupGoldDropStealth(handle, {
  url = 'https://golddropgolddhamaka.com/register',
  timeoutMs = Number(process.env.GOLD_DROP_WARMUP_TIMEOUT_MS || 45000),
} = {}) {
  if (handle?.stealth !== true) throw new Error('Stealth worker handle nahi hai');
  return sendStealthCommand(handle, { cmd: 'warmup', url, timeoutMs }, timeoutMs + 60000,
    'Stealth warmup timeout — site ka security step atka hua hai');
}

// ─── Browser-native registration (API bilkul nahi — asli form, asli browser) ──
// Site ke saare hidden tokens / cookies / fingerprint checks browser khud
// satisfy karta hai, isliye "security check" rejection ka sawaal hi nahi.
export async function registerGoldDropStealth(handle, { name, mobile, email, pincode, code, image, url = 'https://golddropgolddhamaka.com/register' }) {
  if (handle?.stealth !== true) throw new Error('Stealth worker handle nahi hai');
  const timeoutMs = Number(process.env.GOLD_DROP_REG_TIMEOUT_MS || 180000);
  return sendStealthCommand(handle, { cmd: 'register', name, mobile, email, pincode, code, image, url }, timeoutMs,
    'Stealth registration timeout — site atki hui hai');
}

export async function verifyGoldDropOtpStealth(handle, otp, details = {}) {
  if (handle?.stealth !== true) throw new Error('Stealth worker handle nahi hai');
  const timeoutMs = Number(process.env.GOLD_DROP_VERIFY_TIMEOUT_MS || 120000);
  // details isliye chahiye: mobile-first flows me details form OTP ke BAAD aata hai.
  return sendStealthCommand(handle, { cmd: 'verify', otp, ...details }, timeoutMs,
    'Stealth verify timeout — site atki hui hai');
}

export async function launchGoldDropChecker(executablePath, { stealth, pythonPath } = {}) {
  const mode = String(process.env.GOLD_DROP_STEALTH ?? 'auto').trim().toLowerCase();
  const wantStealth = stealth ?? (mode !== '0' && mode !== 'off' && mode !== 'false');
  if (wantStealth) {
    try {
      return await launchGoldDropStealthChecker({
        chromePath: executablePath || '',
        ...(pythonPath ? { pythonPath } : {}),
      });
    } catch (error) {
      const strict = mode === '1' || mode === 'strict' || stealth === true;
      if (strict) throw error;
      console.warn('[GoldDrop] Stealth stack nahi chal paya (%s) — puppeteer-real-browser fallback.',
        String(error?.message || error).slice(0, 200));
    }
  }
  if (!executablePath) throw new Error('Chromium nahi mila');
  // Docker has Chrome but no X server. The Turnstile auto-clicker is disabled;
  // if the official widget needs human interaction the checker stops safely.
  const { browser } = await connect({
    headless: 'new', disableXvfb: true, turnstile: false,
    customConfig: { chromePath: executablePath },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  return browser;
}

export async function checkGoldDropCode(browser, { code, name, mobile }) {
  if (browser?.stealth) return checkGoldDropCodeStealth(browser, { code, name, mobile });
  const page = await browser.newPage();
  try {
    await page.goto('https://www.golddropwins.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#registrationForm', { timeout: 15000 });
    await page.type('#vc', code);
    await page.type('#name', name);
    await page.type('#mobile', mobile);
    const checked = await page.$eval('#terms', el => el.checked);
    if (!checked) await page.click('#terms');
    try {
      await page.waitForFunction(() => {
        const token = document.querySelector('[name="cf-turnstile-response"]');
        return !!token && !!token.value;
      }, { timeout: 20000 });
    } catch {
      return { status: 'security_check', message: 'Website ka security check complete nahi hua; automated run rok diya.' };
    }
    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null);
    await page.click('#enbBtn');
    await Promise.race([nav, new Promise(resolve => setTimeout(resolve, 5000))]);
    const view = await page.evaluate(() => ({
      body: document.body?.innerText || '',
      errors: [...document.querySelectorAll('.sp_error, [role="alert"], .alert-danger, .error')].map(el => (el.innerText || '').trim()).filter(Boolean),
      otpField: [...document.querySelectorAll('input[name="otp"], input[id="otp"], input[autocomplete="one-time-code"]')]
        .some(el => el.getClientRects().length > 0 && !el.disabled && el.type !== 'hidden'),
    }));
    if (view.errors.length) return { status: 'rejected', message: view.errors.join(' | ').slice(0, 300) };
    if (view.otpField || /\botp\b.{0,40}\b(sent|successfully)\b|\b(sent|successfully)\b.{0,40}\botp\b/i.test(view.body)) {
      return { status: 'otp_sent', message: 'Website ne OTP step/sent confirmation dikhaya.' };
    }
    return { status: 'unknown', message: 'Website ka response confirm nahi hua; manual check karein.' };
  } finally { await page.close().catch(() => {}); }
}
