// gold-drop-checker.js
import { connect } from 'puppeteer-real-browser';

export function parseWinningCodes(text, { maxCodes = 100 } = {}) {
  const tokens = String(text || '').split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) throw new Error('Code list khali hai');
  if (tokens.length > maxCodes) throw new Error(`Ek baar mein maximum ${maxCodes} codes bhejein`);
  const invalid = tokens.find(t => !/^[A-Za-z0-9]{1,12}$/.test(t));
  if (invalid) throw new Error('Har code sirf letters/digits ka ho aur 12 characters se bada na ho');
  return [...new Set(tokens.map(t => t.toUpperCase()))];
}

export async function checkGoldDropCode(code, name, mobile) {
  let browser;
  try {
    const response = await connect({
      headless: false, 
      turnstile: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    browser = response.browser;
    const page = response.page;

    await page.goto('https://www.golddropwins.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#registrationForm', { timeout: 60000 });

    await page.type('#vc', code);
    await page.type('#name', name);
    await page.type('#mobile', mobile);

    const isChecked = await page.$eval('#terms', el => el.checked);
    if (!isChecked) {
      await page.click('#terms');
    }

    await new Promise(r => setTimeout(r, 3000));
    await page.click('#enbBtn');
    await new Promise(r => setTimeout(r, 5000));

    const pageText = await page.evaluate(() => document.body.innerText);
    
    if (pageText.match(/otp/i) && pageText.match(/sent|success/i)) {
      return { status: 'otp_sent', message: 'OTP Successfully Sent!' };
    }
    
    const errors = await page.evaluate(() => {
      const errEls = document.querySelectorAll('.sp_error, [role="alert"], .alert-danger, .error');
      return Array.from(errEls).map(el => el.innerText.trim()).filter(Boolean);
    });

    if (errors.length > 0) {
      return { status: 'rejected', message: errors.join(' | ') };
    }

    return { status: 'unknown', message: 'Response clear nahi hai, manually check karein.' };

  } catch (error) {
    return { status: 'error', message: error.message };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
