#!/usr/bin/env python3
"""Gold Drop stealth browser worker — SeleniumBase CDP mode + Playwright.

Flow (video ke steps):
  1. SeleniumBase se stealthy browser launch hota hai (UC mode, "CDP mode").
  2. `sb.get_endpoint_url()` se running browser ka CDP endpoint milta hai.
  3. Playwright `chromium.connect_over_cdp(endpoint_url)` se usi stealthy
     browser se jud jata hai.
  4. Aage ka saara automation standard Playwright commands se hota hai.

Node bot se baat-cheet stdin/stdout par line-delimited JSON (NDJSON) se hoti
hai. stdout SIRF protocol ke liye hai; saare diagnostics stderr par jaate hain.

Commands (stdin, ek JSON object per line):
  {"cmd": "launch", "id": 0, "chromePath": "/path/chrome", "headed": false,
   "turnstileTimeoutMs": 30000}
      -> {"type": "ready", "id": 0, "endpointUrl": "http://127.0.0.1:PORT"}
  {"cmd": "check", "id": 1, "code": "ABC123", "name": "Rahul", "mobile": "98..."}
      -> {"type": "result", "id": 1, "status": "otp_sent", "message": "..."}
      ya {"type": "error", "id": 1, "message": "..."}
  {"cmd": "warmup", "id": 2, "url": "https://golddropgolddhamaka.com/register",
   "timeoutMs": 45000}
      -> {"type": "warmup", "id": 2, "ok": true,
          "userAgent": "Mozilla/5.0 ...", "cookies": [...]}
      Security challenge asli browser fingerprint se khud clear hone deta hai,
      phir clearance cookies + UA wapas deta hai taaki HTTP API client
      (gold-drop-client.js) unke saath "security check" se bach kar chale.
  {"cmd": "ping"}   -> {"type": "pong"}
  {"cmd": "close"}  -> worker safai se band ho kar exit 0 karta hai.

Security boundary: ye worker site ka security check bypass/solve NAHI karta —
sirf ek saaf stealth browser deta hai. Agar official widget human interaction
maange to result `security_check` ke saath wapas jata hai (purane checker jaisa).
"""

import argparse
import contextlib
import io
import json
import re
import sys
import time
import traceback

SITE_URL = "https://www.golddropwins.com/"
DEFAULT_TURNSTILE_TIMEOUT_MS = 30000

# gold-drop-checker.js ke puppeteer version ke saath same classification.
OTP_SENT_RE = re.compile(
    r"\botp\b.{0,40}\b(?:sent|successfully)\b|\b(?:sent|successfully)\b.{0,40}\botp\b",
    re.IGNORECASE | re.DOTALL,
)

TURNSTILE_TOKEN_JS = """() => {
  const token = document.querySelector('[name="cf-turnstile-response"]');
  return !!token && !!token.value;
}"""

PAGE_VIEW_JS = """() => ({
  body: document.body?.innerText || '',
  errors: [...document.querySelectorAll('.sp_error, [role="alert"], .alert-danger, .error')]
    .map(el => (el.innerText || '').trim()).filter(Boolean),
  otpField: [...document.querySelectorAll(
    'input[name="otp"], input[id="otp"], input[autocomplete="one-time-code"]')]
    .some(el => el.getClientRects().length > 0 && !el.disabled && el.type !== 'hidden'),
})"""

# WAF challenge pages (Cloudflare "Just a moment..." style) ka pata lagane ke
# liye signals. Challenge ko solve/click NAHI karte — stealth browser ka asli
# fingerprint passive challenge ko khud clear kara deta hai.
CHALLENGE_TITLE_RE = re.compile(
    r"just a moment|attention required|checking your browser|verify you are|one more step",
    re.IGNORECASE,
)

CHALLENGE_DOM_JS = """() => !!document.querySelector(
  '#challenge-form, #challenge-stage, #cf-chl-running, #cf-challenge-running, '
  + '.cf-browser-verification, #cf-challenge-container, script[src*="challenge-platform"]'
)"""


def challenge_title_active(title):
    """Pure function — title dekh kar batao ki WAF challenge page hai ya nahi."""
    return bool(CHALLENGE_TITLE_RE.search(str(title or "")))


def challenge_active(page):
    """Page abhi bhi security challenge dikha raha hai ya nahi."""
    try:
        title = page.title() or ""
    except Exception:
        return True  # navigation ke beech — abhi clear nahi
    if challenge_title_active(title):
        return True
    try:
        return bool(page.evaluate(CHALLENGE_DOM_JS))
    except Exception:
        return True


def send(payload):
    """Protocol line — stdout par sirf yehi jaana chahiye."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message):
    sys.stderr.write(f"[gold-drop-stealth] {message}\n")
    sys.stderr.flush()


def classify_view(view):
    """Form submit ke baad ka page state -> {status, message}. Pure function."""
    errors = [str(item).strip() for item in (view.get("errors") or []) if str(item).strip()]
    if errors:
        return {"status": "rejected", "message": " | ".join(errors)[:300]}
    body = str(view.get("body") or "")
    if view.get("otpField") or OTP_SENT_RE.search(body):
        return {"status": "otp_sent", "message": "Website ne OTP step/sent confirmation dikhaya."}
    return {"status": "unknown", "message": "Website ka response confirm nahi hua; manual check karein."}


class GoldDropStealthBrowser:
    """SeleniumBase UC/CDP browser jise Playwright connect_over_cdp se drive karta hai."""

    def __init__(self):
        self.sb = None
        self.pw = None
        self.browser = None
        self.context = None
        self.turnstile_timeout_ms = DEFAULT_TURNSTILE_TIMEOUT_MS

    def launch(self, chrome_path="", headed=False, turnstile_timeout_ms=DEFAULT_TURNSTILE_TIMEOUT_MS):
        try:
            from seleniumbase import SB  # noqa: PLC0415 - lazy: ping/selftest ko deps nahi chahiye
            from playwright.sync_api import sync_playwright  # noqa: PLC0415
        except ImportError as error:
            raise RuntimeError(
                "Python stealth deps missing — Dockerfile ka pip install step "
                f"dekhein ({error})"
            ) from error

        sb_kwargs = {"uc": True}
        if chrome_path:
            sb_kwargs["binary_location"] = chrome_path
        if headed:
            # Headed + Xvfb = sabse human-like display (Docker me xvfb install hai).
            sb_kwargs["headed"] = True
            sb_kwargs["xvfb"] = True
        else:
            sb_kwargs["headless2"] = True

        # Step 1+2: SeleniumBase stealthy browser + endpoint_url.
        # SeleniumBase/UC apne messages stdout par print karta hai — protocol
        # channel saaf rakhne ke liye launch ke dauraan stdout redirect karo.
        with contextlib.redirect_stdout(io.StringIO()):
            self.sb = SB(**sb_kwargs)
            self.sb.__enter__()
            # CDP mode activate karo — iske baad browser pure CDP par chalta hai.
            self.sb.activate_cdp_mode("about:blank")
            endpoint_url = self.sb.get_endpoint_url()
        log(f"SeleniumBase CDP endpoint: {endpoint_url}")

        # Step 3: Playwright ko usi stealthy browser se CDP par jodo.
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.connect_over_cdp(endpoint_url)
        contexts = self.browser.contexts
        self.context = contexts[0] if contexts else self.browser.new_context()
        self.turnstile_timeout_ms = int(turnstile_timeout_ms or DEFAULT_TURNSTILE_TIMEOUT_MS)
        return endpoint_url

    def check(self, code, name, mobile):
        """Step 4: standard Playwright commands se official form check."""
        if self.context is None:
            raise RuntimeError("Browser launch nahi hua — pehle launch command bhejo")
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError  # noqa: PLC0415

        page = self.context.new_page()
        try:
            page.goto(SITE_URL, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_selector("#registrationForm", timeout=15000)
            page.fill("#vc", str(code))
            page.fill("#name", str(name))
            page.fill("#mobile", str(mobile))
            if not page.is_checked("#terms"):
                page.click("#terms")
            try:
                page.wait_for_function(TURNSTILE_TOKEN_JS, timeout=self.turnstile_timeout_ms)
            except PlaywrightTimeoutError:
                return {
                    "status": "security_check",
                    "message": "Website ka security check complete nahi hua; automated run rok diya.",
                }
            page.click("#enbBtn", timeout=15000)
            try:
                page.wait_for_load_state("domcontentloaded", timeout=12000)
            except PlaywrightTimeoutError:
                pass
            page.wait_for_timeout(2000)  # OTP step / XHR settle ho jaye
            return classify_view(page.evaluate(PAGE_VIEW_JS))
        finally:
            try:
                page.close()
            except Exception:
                pass

    def warmup(self, url, timeout_ms=45000):
        """Offer page stealth browser me kholo; site ka security challenge asli
        fingerprint se khud clear hone do; clearance cookies + UA wapas do."""
        if self.context is None:
            raise RuntimeError("Browser launch nahi hua — pehle launch command bhejo")
        if not url:
            raise RuntimeError("warmup url required")
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError  # noqa: PLC0415

        page = self.context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            deadline = time.monotonic() + max(5, int(timeout_ms)) / 1000
            cleared = False
            while time.monotonic() < deadline:
                if not challenge_active(page):
                    cleared = True
                    break
                page.wait_for_timeout(1000)
            if not cleared:
                return {
                    "ok": False,
                    "message": "Site ka security challenge abhi bhi active hai; 1 min wait ke baad retry hoga.",
                }
            page.wait_for_timeout(1500)  # clearance cookies set hone ka buffer
            user_agent = page.evaluate("() => navigator.userAgent")
            cookies = self.context.cookies([url])
            log(f"warmup ok — {len(cookies)} cookies, UA: {str(user_agent)[:60]}")
            return {"ok": True, "userAgent": str(user_agent or ""), "cookies": cookies}
        except PlaywrightTimeoutError:
            return {"ok": False, "message": "Warmup page load timeout hua."}
        finally:
            try:
                page.close()
            except Exception:
                pass

    def close(self):
        # Playwright pehle (CDP disconnect), phir SeleniumBase apna Chrome band kare.
        for closer in (
            lambda: self.browser and self.browser.close(),
            lambda: self.pw and self.pw.stop(),
            lambda: self.sb and self.sb.__exit__(None, None, None),
        ):
            try:
                closer()
            except Exception as error:
                log(f"close warning: {error}")
        self.browser = None
        self.pw = None
        self.sb = None
        self.context = None


def serve():
    stealth = GoldDropStealthBrowser()
    exit_code = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except ValueError:
            send({"type": "error", "id": None, "message": "Invalid JSON command"})
            continue
        kind = cmd.get("cmd")
        cmd_id = cmd.get("id")
        try:
            if kind == "ping":
                send({"type": "pong"})
            elif kind == "launch":
                endpoint_url = stealth.launch(
                    chrome_path=str(cmd.get("chromePath") or ""),
                    headed=bool(cmd.get("headed")),
                    turnstile_timeout_ms=int(cmd.get("turnstileTimeoutMs") or DEFAULT_TURNSTILE_TIMEOUT_MS),
                )
                send({"type": "ready", "id": cmd_id, "endpointUrl": endpoint_url})
            elif kind == "check":
                result = stealth.check(cmd.get("code") or "", cmd.get("name") or "", cmd.get("mobile") or "")
                send({"type": "result", "id": cmd_id, **result})
            elif kind == "warmup":
                result = stealth.warmup(
                    str(cmd.get("url") or ""),
                    int(cmd.get("timeoutMs") or 45000),
                )
                send({"type": "warmup", "id": cmd_id, **result})
            elif kind == "close":
                break
            else:
                send({"type": "error", "id": cmd_id, "message": f"Unknown cmd: {kind}"})
        except Exception as error:
            log(traceback.format_exc().rstrip())
            send({"type": "error", "id": cmd_id, "message": str(error)[:300]})
            if kind == "launch":
                # Launch fail = browser kabhi khula hi nahi; worker zinda reh sakta
                # hai (Node fallback decide karta hai), par ab ke liye band karo.
                exit_code = 1
                break
    stealth.close()
    return exit_code


def selftest():
    assert classify_view({"body": "", "errors": ["Invalid winning code"], "otpField": False})["status"] == "rejected"
    assert classify_view({"body": "", "errors": [], "otpField": True})["status"] == "otp_sent"
    assert classify_view({"body": "Your OTP sent successfully", "errors": [], "otpField": False})["status"] == "otp_sent"
    assert classify_view({"body": "successfully sent the OTP", "errors": [], "otpField": False})["status"] == "otp_sent"
    assert classify_view({"body": "kuch confirm nahi", "errors": [], "otpField": False})["status"] == "unknown"
    assert classify_view({"body": "", "errors": [], "otpField": False})["status"] == "unknown"
    assert classify_view({"body": None, "errors": None, "otpField": False})["status"] == "unknown"
    assert challenge_title_active("Just a moment...") is True
    assert challenge_title_active("Attention Required! | Cloudflare") is True
    assert challenge_title_active("Checking your browser before accessing golddropgolddhamaka.com") is True
    assert challenge_title_active("Verify you are human") is True
    assert challenge_title_active("Gold Drop Gold Dhamaka — Register") is False
    assert challenge_title_active("") is False
    assert challenge_title_active(None) is False
    print("selftest OK")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Gold Drop stealth browser worker (SeleniumBase CDP + Playwright)")
    parser.add_argument("--serve", action="store_true", help="NDJSON protocol stdin/stdout par serve karo")
    parser.add_argument("--selftest", action="store_true", help="classification logic ka offline selftest")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    if args.serve:
        return serve()
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
