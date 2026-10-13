// Diagnostics are local and may be exported. Strip secrets before persistence
// as well as on export, including records written by an older development build.
(function () {
  const secretKey = /cookie|authorization|password|secret|token|api[-_]?key|signature|credential/i;
  function text(value) {
    const source = String(value);
    const limited = source.slice(0, 16_000);
    return limited
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
      .replace(/\b[A-Za-z]:[\\/][^\r\n]*|\\\\[^\r\n]*|\/(?:Users|home)\/[^\r\n]*/g, '[redacted path]')
      + (source.length > limited.length ? '\n[truncated text]' : '');
  }
  // Project before JSON/string messaging: shared acyclic graphs otherwise
  // expand exponentially even though structured cloning keeps them small.
  function project(value) {
    const seen = new WeakSet();
    let nodes = 0, edges = 0, remainingText = 8192;
    const boundedText = value => {
      const count = Math.min(value.length, 4096, remainingText);
      remainingText -= count;
      return text(value.slice(0, count)) + (count < value.length ? '[text limit]' : '');
    };
    const visit = (entry, depth) => {
      if (typeof entry === 'string') return boundedText(entry);
      if (entry === null || typeof entry === 'boolean') return entry;
      if (typeof entry === 'number') return Number.isFinite(entry) ? entry : null;
      if (typeof entry !== 'object') return '[unsupported value]';
      if (seen.has(entry)) return '[repeated object]';
      if (depth >= 8 || nodes >= 128 || edges >= 256) return '[object limit]';
      seen.add(entry); nodes++;
      const result = Array.isArray(entry) ? [] : Object.create(null);
      let fields = 0;
      for (const key in entry) {
        if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
        if (fields >= 32 || edges >= 256) break;
        fields++; edges++;
        // Omit huge keys without allocating/traversing all object keys.
        if (key.length > 128) continue;
        const name = Array.isArray(entry) ? result.length : boundedText(key);
        result[name] = secretKey.test(key) ? '[redacted]' : visit(entry[key], depth + 1);
      }
      return result;
    };
    try { return visit(value, 0); } catch { return '[unserializable diagnostic]'; }
  }
  function sanitize(value) {
    if (typeof value === 'string') return text(value);
    try {
      const output = JSON.stringify(project(value));
      return output.length <= 50_000 ? output : '"[diagnostic output limit]"';
    } catch { return '[unserializable diagnostic]'; }
  }
  const api = { sanitize, text, project };
  if (typeof module !== 'undefined') module.exports = api;
  globalThis.MendoDiagnostics = api;
})();
