// Diagnostics are local and may be exported. Strip secrets before persistence
// as well as on export, including records written by an older development build.
(function () {
  const secretKey = /cookie|authorization|password|secret|token|api[-_]?key|signature|credential/i;
  function text(value) {
    return String(value)
      .replace(/\b(?:https?|blob|data):[^\s<>"'\])}]+/gi, (raw) => {
        try {
          const url = new URL(raw);
          return url.protocol === 'https:' || url.protocol === 'http:'
            ? `${url.origin}/[redacted]` : '[redacted URL]';
        } catch { return '[redacted URL]'; }
      })
      .replace(/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*[:=][^\r\n]*/gi, '[redacted header]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/["']?(?:access[_-]?token|refresh[_-]?token|token|password|secret|api[_-]?key|signature|credential|cookie)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\r\n]+)/gi, '[redacted field]')
      // Spaces and apostrophes are valid in paths. Conservatively remove the
      // rest of that line so quoting cannot leave a private filename behind.
      .replace(/\b[A-Za-z]:[\\/][^\r\n]*|\\\\[^\r\n]*|\/(?:Users|home)\/[^\r\n]*/g, '[redacted path]');
  }
  function sanitize(value) {
    if (typeof value === 'string') return text(value);
    try {
      return JSON.stringify(value, (key, entry) => secretKey.test(key)
        ? '[redacted]' : typeof entry === 'string' ? text(entry) : entry);
    } catch { return '[unserializable diagnostic]'; }
  }
  const api = { sanitize, text };
  if (typeof module !== 'undefined') module.exports = api;
  globalThis.MendoDiagnostics = api;
})();
