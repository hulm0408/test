# ===== Swiggy Fresh Bot — Render (Docker) =====
# Kyun Docker? Render ke native Node environment me Chrome NAHI hota, aur
# bina Chrome ke WAF solver nahi chalta (har OTP par 403). Is image me
# google-chrome-stable pehle se install hai — bot use khud dhoondh lega.
FROM node:22-bookworm-slim

# Chrome install (puppeteer-core ke liye browser system se chahiye).
# Google ke official current .deb ko seedha install karo — alag APT repo +
# signing-key wala route key rotation par NO_PUBKEY dekar poora Render
# build gira sakta hai. Download me retries bhi rakhe hain taaki ek
# temporary network jhatka deploy na rok de.
RUN set -eux; \
    apt-get -o Acquire::Retries=3 update; \
    apt-get install -y --no-install-recommends wget ca-certificates fonts-liberation; \
    wget --tries=5 --waitretry=5 --timeout=30 \
      -O /tmp/google-chrome-stable.deb \
      https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; \
    apt-get install -y --no-install-recommends /tmp/google-chrome-stable.deb; \
    rm -f /tmp/google-chrome-stable.deb; \
    rm -rf /var/lib/apt/lists/*; \
    google-chrome-stable --version

ENV NODE_ENV=production \
    HEADLESS=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# ── Gold Drop stealth stack (SeleniumBase CDP mode + Playwright) ──
# Checker (gold-drop-checker.js) ka default engine ab Python worker
# (gold_drop_stealth.py) hai: SeleniumBase stealthy Chrome launch karti hai,
# endpoint_url deti hai, aur Playwright connect_over_cdp se drive hota hai.
# Playwright ko APNA browser download karne ki zaroorat NAHI hai — wo isi
# image ke google-chrome-stable se CDP par judta hai. xvfb optional headed
# mode ke liye (GOLD_DROP_HEADED=1), jo Turnstile ke liye zyada human lagta hai.
# libatomic1 ZAROORI hai: Playwright ka embedded node driver (driver/node)
# slim image par bina iske crash hota hai — "error while loading shared
# libraries: libatomic.so.1" → phir "Connection closed while reading from the
# driver". (Render deploy 2026-11-18 me yahi aaya tha — mat hatana.)
RUN set -eux; \
    apt-get -o Acquire::Retries=3 update; \
    apt-get install -y --no-install-recommends python3 python3-venv xvfb libatomic1; \
    rm -rf /var/lib/apt/lists/*; \
    python3 -m venv /opt/golddrop-venv; \
    /opt/golddrop-venv/bin/pip install --no-cache-dir --upgrade pip; \
    /opt/golddrop-venv/bin/pip install --no-cache-dir seleniumbase playwright; \
    /opt/golddrop-venv/bin/sbase get uc_driver || echo "uc_driver abhi nahi mila — pehli run par download hoga"

ENV GOLD_DROP_PYTHON=/opt/golddrop-venv/bin/python

WORKDIR /app

# Pehle sirf package files (layer cache — code badle par npm dobara na chale)
COPY package.json package-lock.json ./
# Registry ke temporary network jhatke par npm khud kuch dafa retry kare;
# lockfile phir bhi exact wahi rahegi (npm ci kabhi versions nahi badalta).
RUN npm ci --omit=dev \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000

COPY . .

# Fail the image build, not the running service, if the optional checker has
# a missing production dependency. Never launch the bot or contact Telegram here.
RUN node --input-type=module -e "const m = await import('./gold-drop-checker.js'); if (typeof m.launchGoldDropChecker !== 'function' || typeof m.checkGoldDropCode !== 'function') throw new Error('Gold Drop checker API missing'); console.log('Gold Drop checker dependencies and API OK')"

# Stealth worker (SeleniumBase CDP + Playwright) ka syntax + classification
# selftest bhi build par hi verify ho jaye — browser launch yahan NAHI hota.
RUN /opt/golddrop-venv/bin/python -m py_compile gold_drop_stealth.py \
    && /opt/golddrop-venv/bin/python gold_drop_stealth.py --selftest

# data/ = bot ka db (settings/accounts). Render par persistent disk yahin
# mount hoga (render.yaml dekho) — bina disk ke ye folder har deploy par
# fresh hoga aur accounts cloud vault se wapas aayenge (hydrate).
RUN mkdir -p /app/data

CMD ["node", "fresh-bot.js"]
