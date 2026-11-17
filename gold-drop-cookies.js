// Minimal in-memory cookie jar for one Gold Drop browser/API session.
// Never persist or log cookie values. Only the configured origin and applicable
// paths receive cookies; session deletion and expiry are respected.
export class GoldDropCookieJar {
  constructor(origin) {
    this.origin = new URL(origin);
    this.cookies = new Map();
  }

  store(headers, requestUrl) {
    const url = new URL(requestUrl);
    if (url.origin !== this.origin.origin) return;
    const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of values) {
      const parts = String(raw).split(';');
      const first = parts.shift();
      const equals = first.indexOf('=');
      if (equals <= 0) continue;
      const name = first.slice(0, equals).trim();
      const value = first.slice(equals + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x20\x7f;,]/.test(value)) continue;
      let domain = url.hostname.toLowerCase(), hostOnly = true;
      let path = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
      let secure = false, expires = Infinity, maxAge = null;
      for (const part of parts) {
        const eq = part.indexOf('=');
        const key = (eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
        const val = eq < 0 ? '' : part.slice(eq + 1).trim();
        if (key === 'domain') {
          const proposed = val.replace(/^\./, '').toLowerCase();
          if (!proposed || (url.hostname !== proposed && !url.hostname.endsWith(`.${proposed}`))) { domain = ''; break; }
          // Reject parent-domain cookies; this client needs only this service's session.
          if (proposed !== this.origin.hostname.toLowerCase()) { domain = ''; break; }
          domain = proposed; hostOnly = false;
        } else if (key === 'path' && val.startsWith('/')) path = val;
        else if (key === 'secure') secure = true;
        else if (key === 'expires') { const date = Date.parse(val); if (Number.isFinite(date)) expires = date; }
        else if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = Number(val);
      }
      if (!domain) continue;
      if (maxAge !== null) expires = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
      const id = `${domain}|${path}|${name}`;
      if (expires <= Date.now()) this.cookies.delete(id);
      else this.cookies.set(id, { name, value, domain, hostOnly, path, secure, expires });
    }
  }

  header(requestUrl, userKey = '') {
    const url = new URL(requestUrl);
    if (url.origin !== this.origin.origin) return '';
    const parts = [];
    for (const [id, cookie] of this.cookies) {
      if (cookie.expires <= Date.now()) { this.cookies.delete(id); continue; }
      if (cookie.name === 'gold-drop-id' && userKey) continue;
      const domainMatches = cookie.hostOnly ? url.hostname === cookie.domain : (url.hostname === cookie.domain || url.hostname.endsWith(`.${cookie.domain}`));
      const pathMatches = url.pathname === cookie.path || (url.pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/'));
      if (domainMatches && pathMatches && (!cookie.secure || url.protocol === 'https:')) parts.push(`${cookie.name}=${cookie.value}`);
    }
    if (userKey) {
      if (!/^[A-Za-z0-9._~-]+$/.test(userKey)) throw new Error('Invalid Gold Drop session key');
      parts.push(`gold-drop-id=${userKey}`);
    }
    return parts.join('; ');
  }
}
