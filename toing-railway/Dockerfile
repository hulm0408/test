# ===== Toing Pro 50-Slot Parallel Engine — Railway (Lightweight Node 22) =====
# Pure HTTP + MTProto + built-in node:sqlite (WAL).
# Zero Chrome, zero Python, zero native C++ compilation -> builds in ~15 seconds.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund --fetch-retries=5; \
    else \
      npm install --omit=dev --no-audit --no-fund --fetch-retries=5; \
    fi

COPY . .

# Verify built-in node:sqlite + ESM syntax of all source files at build time
RUN node --no-warnings=ExperimentalWarning --input-type=module -e \
    "import { DatabaseSync } from 'node:sqlite'; const d = new DatabaseSync(':memory:'); d.close(); console.log('node:sqlite OK');" \
    && for f in src/*.js; do node --check "$f" || exit 1; done \
    && echo "All src/*.js syntax OK"

RUN mkdir -p /data /data/sessions

EXPOSE 3000

CMD ["node", "--no-warnings=ExperimentalWarning", "src/index.js"]
