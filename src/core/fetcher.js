/**
 * Polite HTTP fetching.
 *
 * Contract: one request at a time per host, with a minimum gap between them.
 * Everything else (retries, timeouts, redirect tracking) is layered on top of
 * Node's global fetch, so there is no HTTP dependency.
 */

import { origin } from '../util/url.js';

export const DEFAULT_USER_AGENT =
  'LabelScraperBot/1.0 (+https://example.invalid/bot; label-driven structured data extraction)';

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serial queue per key, with a minimum delay between completed tasks. */
class HostQueue {
  constructor(minDelayMs, jitterMs) {
    this.minDelayMs = minDelayMs;
    this.jitterMs = jitterMs;
    /** @type {Map<string, {chain: Promise<any>, lastAt: number, delayMs: number}>} */
    this.hosts = new Map();
  }

  setDelay(key, delayMs) {
    const entry = this._entry(key);
    if (delayMs > entry.delayMs) entry.delayMs = delayMs;
  }

  _entry(key) {
    if (!this.hosts.has(key)) {
      this.hosts.set(key, { chain: Promise.resolve(), lastAt: 0, delayMs: this.minDelayMs });
    }
    return this.hosts.get(key);
  }

  run(key, task) {
    const entry = this._entry(key);
    const next = entry.chain.then(async () => {
      const wait = entry.lastAt
        ? entry.lastAt + entry.delayMs + Math.random() * this.jitterMs - Date.now()
        : 0;
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        entry.lastAt = Date.now();
      }
    });
    // Keep the chain alive even if this task rejected.
    entry.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export class Fetcher {
  constructor({
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = 20000,
    retries = 2,
    minDelayMs = 1200,
    jitterMs = 400,
    maxBytes = 5 * 1024 * 1024,
    logger = null,
  } = {}) {
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.maxBytes = maxBytes;
    this.logger = logger;
    this.queue = new HostQueue(minDelayMs, jitterMs);
  }

  /** Raise the per-host delay (used to honour robots.txt Crawl-delay). */
  setHostDelay(url, delayMs) {
    const key = origin(url);
    if (key && delayMs) this.queue.setDelay(key, delayMs);
  }

  /**
   * @returns {Promise<{ok: boolean, status: number, body: string, finalUrl: string,
   *                    contentType: string, error?: string, errorType?: string}>}
   */
  async get(url, { accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } = {}) {
    const key = origin(url) ?? url;
    return this.queue.run(key, () => this._attempt(url, accept));
  }

  async _attempt(url, accept) {
    let lastError = { error: 'unknown', errorType: 'network' };

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) {
        const backoff = Math.min(15000, 800 * 2 ** attempt) + Math.random() * 400;
        this.logger?.debug(`retry ${attempt} for ${url} in ${Math.round(backoff)}ms`);
        await sleep(backoff);
      }

      let res;
      try {
        res = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            'User-Agent': this.userAgent,
            Accept: accept,
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
          },
        });
      } catch (err) {
        const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
        lastError = {
          error: timedOut ? `Request timed out after ${this.timeoutMs}ms` : err.message,
          errorType: timedOut ? 'timeout' : 'network',
        };
        continue;
      }

      if (!res.ok && RETRY_STATUS.has(res.status)) {
        const retryAfter = Number(res.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 30) {
          await sleep(retryAfter * 1000);
        }
        lastError = {
          error: `HTTP ${res.status} ${res.statusText}`,
          errorType: res.status === 429 ? 'rate_limited' : 'http_error',
          status: res.status,
        };
        continue;
      }

      const contentType = res.headers.get('content-type') ?? '';
      const body = await this._readCapped(res);

      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          body,
          finalUrl: res.url || url,
          contentType,
          error: `HTTP ${res.status} ${res.statusText}`,
          errorType:
            res.status === 401 ? 'login_required' : res.status === 403 ? 'blocked' : 'http_error',
        };
      }

      return { ok: true, status: res.status, body, finalUrl: res.url || url, contentType };
    }

    return {
      ok: false,
      status: lastError.status ?? 0,
      body: '',
      finalUrl: url,
      contentType: '',
      error: lastError.error,
      errorType: lastError.errorType,
    };
  }

  /** Read the body but stop at maxBytes so one huge page cannot exhaust memory. */
  async _readCapped(res) {
    if (!res.body) return '';
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let total = 0;
    let out = '';
    for await (const chunk of res.body) {
      total += chunk.length ?? chunk.byteLength ?? 0;
      out += decoder.decode(chunk, { stream: true });
      if (total >= this.maxBytes) {
        this.logger?.warn(`truncated body at ${this.maxBytes} bytes: ${res.url}`);
        break;
      }
    }
    out += decoder.decode();
    return out;
  }

  /** Convenience wrapper used by the robots gate. */
  fetchText = async (url) => {
    const r = await this.get(url, { accept: 'text/plain,*/*;q=0.8' });
    return { ok: r.ok, status: r.status, body: r.body };
  };
}
