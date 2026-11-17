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
import base64
import contextlib
import io
import json
import os
import re
import sys
import tempfile
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


def _fill_field(page, field, value):
    """Pehla visible+unused matching input bharna; bhara hua element mark hota hai."""
    for selector in FIELD_SELECTORS[field]:
        locator = page.locator(f"{selector}:not([data-gd-filled])")
        try:
            count = locator.count()
        except Exception:
            continue
        for index in range(min(count, 5)):
            element = locator.nth(index)
            try:
                if not element.is_visible():
                    continue
                element.fill(str(value), timeout=3000)
                element.evaluate("el => el.setAttribute('data-gd-filled', '1')")
                return True
            except Exception:
                continue
    return False


def _click_submit(page):
    for selector in SUBMIT_SELECTORS:
        locator = page.locator(selector)
        try:
            count = locator.count()
        except Exception:
            continue
        for index in range(min(count, 4)):
            element = locator.nth(index)
            try:
                if not element.is_visible():
                    continue
                element.click(timeout=5000)
                return True
            except Exception:
                continue
    return False


def _otp_boxes_visible(page):
    """Split-digit OTP boxes (4-8 alag maxlength=1 inputs) dikhte hain?"""
    try:
        locator = page.locator("input[maxlength='1']")
        count = locator.count()
        if count < 4:
            return []
        visible = [locator.nth(i) for i in range(count)]
        visible = [el for el in visible if el.is_visible()]
        return visible if 4 <= len(visible) <= 8 else []
    except Exception:
        return []


def _otp_field_visible(page):
    for selector in OTP_FIELD_SELECTORS:
        locator = page.locator(selector)
        try:
            for index in range(min(locator.count(), 3)):
                if locator.nth(index).is_visible():
                    return True
        except Exception:
            continue
    return bool(_otp_boxes_visible(page))


def _fill_otp(page, otp):
    for selector in OTP_FIELD_SELECTORS:
        locator = page.locator(selector)
        try:
            for index in range(min(locator.count(), 3)):
                element = locator.nth(index)
                if element.is_visible():
                    element.fill(str(otp), timeout=3000)
                    return True
        except Exception:
            continue
    boxes = _otp_boxes_visible(page)
    if boxes:
        for element, digit in zip(boxes, str(otp)):
            element.fill(digit, timeout=2000)
        return True
    return False


# Wizard ka agla step aaya? (koi visible khaali text input jo abhi bhara nahi)
UNFILLED_INPUT_JS = """() => [...document.querySelectorAll(
  'input:not([type]), input[type="text"], input[type="tel"], input[type="email"], input[type="number"]'
)].some(el => !el.dataset.gdFilled && !el.value && el.getClientRects().length > 0
  && !el.disabled && !el.readOnly)"""


def _fill_details(page, fields, image_b64, image_state):
    """Jo fields is step par visible hain wo bharo + photo upload + terms tick.
    image_state = {"path": str, "uploaded": bool} — temp file reuse/cleanup ke liye."""
    for field, value in fields:
        if value:
            _fill_field(page, field, value)
    if image_b64 and not image_state["uploaded"]:
        try:
            file_input = page.locator("input[type='file']")
            if file_input.count() > 0 and file_input.first.is_visible():
                if not image_state["path"]:
                    handle, image_state["path"] = tempfile.mkstemp(suffix=".jpg")
                    with os.fdopen(handle, "wb") as tmp:
                        tmp.write(base64.b64decode(image_b64))
                file_input.first.set_input_files(image_state["path"])
                image_state["uploaded"] = True
        except Exception as error:
            log(f"photo upload warning: {error}")
    try:
        boxes = page.locator("input[type='checkbox']")
        for index in range(min(boxes.count(), 6)):
            box = boxes.nth(index)
            if box.is_visible() and not box.is_checked():
                box.check()
    except Exception:
        pass


def _wait_outcome(page, timeout_s):
    """Submit ke baad poll: 'error' (site text verbatim) / 'otp' / 'done' /
    'next' (wizard ka agla step) / 'unclear' (timeout)."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        errors = _page_errors(page)
        if errors:
            return ("error", " | ".join(errors)[:300])
        if _otp_field_visible(page):
            return ("otp", "Site ne OTP step dikhaya.")
        try:
            body = page.evaluate(BODY_TEXT_JS) or ""
        except Exception:
            body = ""
        if SUCCESS_RE.search(body) and not challenge_active(page):
            return ("done", "Site ne success dikhaya.")
        try:
            if page.evaluate(UNFILLED_INPUT_JS):
                return ("next", "")
        except Exception:
            pass
        page.wait_for_timeout(1000)
    return ("unclear", "")


def _page_errors(page):
    try:
        return [str(item).strip() for item in (page.evaluate(ERROR_TEXT_JS) or []) if str(item).strip()]
    except Exception:
        return []


def _screenshot_b64(page):
    """Failure debugging ke liye chhota JPEG screenshot (base64)."""
    try:
        return base64.b64encode(page.screenshot(type="jpeg", quality=55)).decode("ascii")
    except Exception:
        return ""


# ─── Registration form automation (poora flow stealth browser ke andar) ───
# API reverse-engineering ke bajaye asli form bharte hain — site ke saare
# hidden tokens/cookies/fingerprint checks browser khud satisfy karta hai.

# Priority order matters: 'pincode' me 'code' aa jata hai, isliye pincode
# pehle. Har rule ka pehla visible+unused input liya jata hai.
FIELD_SELECTORS = {
    "email": [
        "input[type='email']",
        "input[name*='email' i]", "input[id*='email' i]", "input[placeholder*='email' i]",
    ],
    "pincode": [
        "input[name*='pin' i]", "input[id*='pin' i]", "input[placeholder*='pin' i]",
        "input[name*='zip' i]", "input[name*='postal' i]", "input[placeholder*='postal' i]",
    ],
    "mobile": [
        "input[type='tel']",
        "input[name*='mobile' i]", "input[id*='mobile' i]", "input[placeholder*='mobile' i]",
        "input[name*='phone' i]", "input[placeholder*='phone' i]",
        "input[name*='number' i]", "input[placeholder*='number' i]",
        "input[name*='whatsapp' i]", "input[placeholder*='whatsapp' i]",
    ],
    "code": [
        "input[name*='batch' i]", "input[id*='batch' i]", "input[placeholder*='batch' i]",
        "input[name*='coupon' i]", "input[name*='voucher' i]", "input[placeholder*='coupon' i]",
        "input[name*='code' i]", "input[id*='code' i]", "input[placeholder*='code' i]",
    ],
    "name": [
        "input[name*='name' i]", "input[id*='name' i]", "input[placeholder*='name' i]",
    ],
}

OTP_FIELD_SELECTORS = [
    "input[autocomplete='one-time-code']",
    "input[name*='otp' i]", "input[id*='otp' i]", "input[placeholder*='otp' i]",
]

SUBMIT_SELECTORS = [
    "button[type='submit']", "input[type='submit']",
    "button:has-text('get started')", "button:has-text('start')",
    "button:has-text('register')", "button:has-text('submit')",
    "button:has-text('send otp')", "button:has-text('get otp')",
    "button:has-text('verify')", "button:has-text('confirm')",
    "button:has-text('continue')", "button:has-text('next')",
    "button:has-text('proceed')", "button:has-text('participate')",
    "a:has-text('get started')", "a:has-text('register')", "a:has-text('participate')",
    "form button",
]

ERROR_TEXT_JS = """() => [...document.querySelectorAll(
  '.sp_error, [role="alert"], .alert-danger, .alert-danger li, .error, .text-danger, .invalid-feedback'
)].map(el => (el.innerText || '').trim()).filter(Boolean)"""

BODY_TEXT_JS = "() => (document.body?.innerText || '')"

SUCCESS_RE = re.compile(r"success|verified|congrat|registered|thank\s*you", re.IGNORECASE)


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
        self.sb_cm = None
        self.pw = None
        self.browser = None
        self.context = None
        self.reg_page = None
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
        # Docker/Render root container me Chrome ke liye zaroori flags.
        sb_kwargs["chromium_arg"] = "--no-sandbox --disable-dev-shm-usage --disable-gpu"

        # Step 1+2: SeleniumBase stealthy browser + endpoint_url.
        # SB(...) ek _GeneratorContextManager return karta hai — ASLI sb object
        # sirf __enter__() ka return value hota hai (yehi AttributeError tha).
        # SeleniumBase/UC apne messages stdout par print karta hai — protocol
        # channel saaf rakhne ke liye launch ke dauraan stdout redirect karo.
        with contextlib.redirect_stdout(io.StringIO()):
            self.sb_cm = SB(**sb_kwargs)
            self.sb = self.sb_cm.__enter__()
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

    def register(self, *, url, name, mobile, email, pincode, code, image_b64):
        """POORA registration stealth browser ke andar — koi raw API nahi.
        Landing CTA ("Get Started") se lekar multi-step wizard tak: har step
        par jo fields visible hain wo bharta hai, photo upload karta hai,
        terms tick karta hai, site ka apna button click karta hai. Site ke
        saare hidden tokens/cookies/fingerprint browser khud satisfy karta
        hai. Page ko verify step ke liye rakhta hai."""
        if self.context is None:
            raise RuntimeError("Browser launch nahi hua — pehle launch command bhejo")
        self._close_reg_page()
        page = self.context.new_page()
        self.reg_page = page
        image_state = {"path": "", "uploaded": False}
        try:
            page.goto(url or REGISTER_URL, wait_until="domcontentloaded", timeout=45000)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline and challenge_active(page):
                page.wait_for_timeout(1000)
            if challenge_active(page):
                return {"ok": False, "message": "Site ka security challenge abhi bhi active hai; baad me try karein.",
                        "screenshot": _screenshot_b64(page)}
            page.wait_for_timeout(1200)

            fields = (("name", name), ("mobile", mobile), ("email", email),
                      ("pincode", pincode), ("code", code))
            clicked_any = False
            for _step in range(4):  # landing CTA + multi-step wizard
                _fill_details(page, fields, image_b64, image_state)
                if not _click_submit(page):
                    if not clicked_any:
                        return {"ok": False, "message": "Form ya Get Started/Submit button nahi mila.",
                                "screenshot": _screenshot_b64(page)}
                    break
                clicked_any = True
                status, message = _wait_outcome(page, 15)
                if status == "error":
                    return {"ok": False, "message": message, "screenshot": _screenshot_b64(page)}
                if status in ("otp", "done"):
                    return {"ok": True, "stage": status, "message": message}
                if status == "unclear":
                    break
                # "next" → wizard ka agla step, loop jaari
            return {"ok": False, "message": "Submit ke baad site ka response clear nahi hua.",
                    "screenshot": _screenshot_b64(page)}
        finally:
            if image_state["path"]:
                try:
                    os.unlink(image_state["path"])
                except OSError:
                    pass

    def verify(self, otp, *, name="", mobile="", email="", pincode="", code="", image_b64=""):
        """register() ke baad wale page par OTP bharna aur verify karna.
        Mobile-first flows me details form OTP ke BAAD aata hai — wo step bhi
        yahin complete hota hai."""
        page = self.reg_page
        if page is None:
            raise RuntimeError("Register page nahi mila — pehle register command bhejo")
        image_state = {"path": "", "uploaded": False}
        try:
            if not _fill_otp(page, otp):
                return {"ok": False, "message": "OTP input nahi mila.",
                        "screenshot": _screenshot_b64(page)}
            if not _click_submit(page):
                return {"ok": False, "message": "Verify button nahi mila.",
                        "screenshot": _screenshot_b64(page)}
            fields = (("name", name), ("mobile", mobile), ("email", email),
                      ("pincode", pincode), ("code", code))
            for _step in range(3):
                status, message = _wait_outcome(page, 20)
                if status == "error":
                    return {"ok": False, "message": message}
                if status == "done":
                    return {"ok": True, "message": message}
                if status == "next":
                    # OTP ke baad details wala step aaya — bharo aur submit karo.
                    _fill_details(page, fields, image_b64, image_state)
                    if not _click_submit(page):
                        return {"ok": False, "message": "Details step ka submit button nahi mila.",
                                "screenshot": _screenshot_b64(page)}
                    continue
                # "otp" dobara ya "unclear" — block mat karo, reward SMS confirm karega.
                return {"ok": True, "message": "Verify response unclear — reward SMS se confirm hoga."}
            return {"ok": True, "message": "Verify response unclear — reward SMS se confirm hoga."}
        finally:
            if image_state["path"]:
                try:
                    os.unlink(image_state["path"])
                except OSError:
                    pass
            self._close_reg_page()

    def _close_reg_page(self):
        page = getattr(self, "reg_page", None)
        self.reg_page = None
        if page is not None:
            try:
                page.close()
            except Exception:
                pass

    def close(self):
        # Playwright pehle (CDP disconnect), phir SeleniumBase apna Chrome band kare.
        self._close_reg_page()
        for closer in (
            lambda: self.browser and self.browser.close(),
            lambda: self.pw and self.pw.stop(),
            lambda: self.sb_cm and self.sb_cm.__exit__(None, None, None),
        ):
            try:
                closer()
            except Exception as error:
                log(f"close warning: {error}")
        self.browser = None
        self.pw = None
        self.sb = None
        self.sb_cm = None
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
            elif kind == "register":
                result = stealth.register(
                    url=str(cmd.get("url") or ""),
                    name=str(cmd.get("name") or ""),
                    mobile=str(cmd.get("mobile") or ""),
                    email=str(cmd.get("email") or ""),
                    pincode=str(cmd.get("pincode") or ""),
                    code=str(cmd.get("code") or ""),
                    image_b64=str(cmd.get("image") or ""),
                )
                send({"type": "register", "id": cmd_id, **result})
            elif kind == "verify":
                result = stealth.verify(
                    str(cmd.get("otp") or ""),
                    name=str(cmd.get("name") or ""),
                    mobile=str(cmd.get("mobile") or ""),
                    email=str(cmd.get("email") or ""),
                    pincode=str(cmd.get("pincode") or ""),
                    code=str(cmd.get("code") or ""),
                    image_b64=str(cmd.get("image") or ""),
                )
                send({"type": "verify", "id": cmd_id, **result})
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
