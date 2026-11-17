// Official redemption form helper. The site supplies its own security check;
// no challenge response is generated, reused, or bypassed by this module.
import { connect } from 'puppeteer-real-browser';

export function parseWinningCodes(text, { maxCodes = 100 } = {}) {
  const tokens = String(text || '').split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) throw new Error('Code list khali hai');
  if (tokens.length > maxCodes) throw new Error(`Ek baar mein maximum ${maxCodes} codes bhejein`);
  const invalid = tokens.find(token => !/^[A-Za-z0-9]{1,12}$/.test(token));
  if (invalid) throw new Error('Har code sirf letters/digits ka ho aur 12 characters se bada na ho');
  return [...new Set(tokens.map(token => token.toUpperCase()))];
}

export async function launchGoldDropChecker(executablePath) {
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
