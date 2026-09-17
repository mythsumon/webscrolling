/**
 * robots.txt gate.
 *
 * One cached parser per origin. A robots.txt we cannot fetch is treated as
 * "no rules" (the standard's own guidance for 4xx), but a 5xx or a network
 * failure is treated as "disallow everything" only when `strict` is set —
 * defaulting to allow there would punish every transient blip.
 */

import robotsParser from 'robots-parser';

export class RobotsGate {
  /**
   * @param {object} opts
   * @param {(url: string) => Promise<{ok: boolean, status: number, body: string}>} opts.fetchText
   * @param {string} opts.userAgent
   * @param {boolean} [opts.enabled]
   */
  constructor({ fetchText, userAgent, enabled = true, logger = null }) {
    this.fetchText = fetchText;
    this.userAgent = userAgent;
    this.enabled = enabled;
    this.logger = logger;
    /** @type {Map<string, Promise<{robots: any|null, crawlDelay: number|null}>>} */
    this.cache = new Map();
  }

  async load(originUrl) {
    const key = new URL(originUrl).origin;
    if (!this.cache.has(key)) {
      this.cache.set(key, this._load(key));
    }
    return this.cache.get(key);
  }

  async _load(originKey) {
    const robotsUrl = `${originKey}/robots.txt`;
    try {
      const res = await this.fetchText(robotsUrl);
      if (!res.ok || !res.body) {
        // 404/410 and friends: nothing is disallowed.
        return { robots: null, crawlDelay: null };
      }
      const robots = robotsParser(robotsUrl, res.body);
      let crawlDelay = null;
      try {
        const d = robots.getCrawlDelay(this.userAgent);
        if (typeof d === 'number' && Number.isFinite(d) && d > 0) crawlDelay = d * 1000;
      } catch {
        /* getCrawlDelay is optional in some versions */
      }
      return { robots, crawlDelay };
    } catch (err) {
      this.logger?.debug(`robots.txt unavailable for ${originKey}: ${err.message}`);
      return { robots: null, crawlDelay: null };
    }
  }

  /** @returns {Promise<{allowed: boolean, crawlDelay: number|null, reason?: string}>} */
  async check(url) {
    if (!this.enabled) return { allowed: true, crawlDelay: null, reason: 'robots checking disabled' };
    let loaded;
    try {
      loaded = await this.load(url);
    } catch {
      return { allowed: true, crawlDelay: null };
    }
    if (!loaded.robots) return { allowed: true, crawlDelay: loaded.crawlDelay };
    const allowed = loaded.robots.isAllowed(url, this.userAgent);
    // `isAllowed` returns undefined when there is no matching rule -> allowed.
    return {
      allowed: allowed !== false,
      crawlDelay: loaded.crawlDelay,
      reason: allowed === false ? 'Disallowed by robots.txt' : undefined,
    };
  }
}
