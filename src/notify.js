'use strict';
// Fire-and-forget alerts to a webhook: Discord and Slack get a plain message,
// anything else gets JSON { event, message, time, ...data }.
// Never throws, never blocks the stream; repeats of the same event are rate-limited.

class Notifier {
  constructor({ log = () => {}, minIntervalMs = 10000 } = {}) {
    this.log = log;
    this.url = '';
    this.minIntervalMs = minIntervalMs;
    this.lastSent = new Map(); // event -> time
    this.sent = 0;
    this.failed = 0;
  }

  setUrl(url) { this.url = url || ''; }
  get enabled() { return !!this.url; }

  send(event, message, data = {}) {
    if (!this.url || typeof fetch !== 'function') return false;
    const now = Date.now();
    if (now - (this.lastSent.get(event) || 0) < this.minIntervalMs) return false;
    this.lastSent.set(event, now);
    const text = `InstantDelay: ${message}`;
    let body;
    if (/discord(app)?\.com\/api\/webhooks\//i.test(this.url)) body = { content: text };
    else if (/hooks\.slack\.com\//i.test(this.url)) body = { text };
    else body = { event, message, time: new Date(now).toISOString(), ...data };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); this.sent++; })
      .catch((e) => { this.failed++; if (this.failed <= 3) this.log(`webhook failed: ${e.message}`); })
      .finally(() => clearTimeout(timer));
    return true;
  }
}

module.exports = { Notifier };
