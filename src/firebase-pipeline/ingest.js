// ===== Firebase Phone-Registration Pipeline — Ingest =====
// Paste box / .txt upload (AIza prefix, 39 chars, ASCII, validation probes 1-4).

import { validateKey, probeKey } from './key-scoring.js';
import { normalizeIndianMobileNumber } from '../../phone-utils.js';

export class Ingest {
  constructor(fetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
  }

  // Parse paste box / .txt upload for keys
  parseKeys(text) {
    const lines = String(text || '').split(/[\r\n,;]+/);
    const keys = [];
    const invalid = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Look for AIza prefix, 39 chars
      const match = trimmed.match(/AIza[A-Za-z0-9_-]{34}/);
      if (match) {
        keys.push(match[0]);
      } else {
        invalid.push({ input: trimmed.slice(0, 50), error: 'Invalid key format' });
      }
    }
    return { keys: [...new Set(keys)], invalid };
  }

  // Parse numbers from paste box / .txt upload
  parseNumbers(text) {
    const lines = String(text || '').split(/[\r\n,;]+/);
    const numbers = [];
    const invalid = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      const phone = normalizeIndianMobileNumber(trimmed);
      if (phone) {
        numbers.push(phone);
      } else {
        invalid.push({ input: trimmed.slice(0, 50), error: 'Invalid number format' });
      }
    }
    return { numbers: [...new Set(numbers)], invalid };
  }

  // Validation probes 1-4 (Recaptcha, Project, OTP Canary, Latency)
  async probeBatch(keys) {
    const results = [];
    for (const key of keys) {
      const probe = await probeKey(key, this.fetchImpl);
      results.push({ key, ...probe });
    }
    return results;
  }

  // Shape-check for uploaded files
  validateShape(fileContent) {
    // Simple check: if JSON, must have keys or numbers array
    try {
      const parsed = JSON.parse(fileContent);
      if (Array.isArray(parsed)) return { ok: true, type: 'array' };
      if (parsed.keys || parsed.numbers) return { ok: true, type: 'object' };
      return { ok: false, error: 'Invalid JSON shape' };
    } catch (_) {
      // Text format check
      const lines = String(fileContent || '').split(/[\r\n,;]+/);
      const hasKeys = lines.some(l => /AIza[A-Za-z0-9_-]{34}/.test(l));
      const hasNumbers = lines.some(l => /^[6-9]\d{9}$/.test(l.replace(/\D/g, '')));
      if (hasKeys || hasNumbers) return { ok: true, type: 'text' };
      return { ok: false, error: 'Invalid text shape' };
    }
  }
}
