/**
 * Playwright rendering for JavaScript-built pages.
 *
 * Two jobs:
 *   1. decide whether a page even needs a browser (`needsRendering`)
 *   2. render it properly when it does — settle, auto-scroll, optional
 *      "load more" clicks — and return HTML we can parse like any other.
 *
 * Playwright is imported lazily so the engine still runs (static-only) when
 * browsers are not installed. That matters: `npm i` gets the package but
 * `playwright install chromium` is a separate step people forget.
 */

import { squish } from '../util/text.js';

/** Resource types blocked while rendering — big win on page-load time. */
const BLOCKED_TYPES = new Set(['font', 'media']);
const BLOCKED_URL_RE =
  /(google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|clarity\.ms|segment\.io|intercom|mixpanel|fullstory|optimizely|criteo|taboola|adservice)/i;

/**
 * Does this static HTML look like it needs a browser?
 * @param {{html: string, text: string, $: import('cheerio').CheerioAPI}} page
 * @param {{requiredFieldsUnresolved?: boolean}} [signals]
 * @returns {{needed: boolean, reason: string|null}}
 */
export function needsRendering({ html, text, $ }, signals = {}) {
  const htmlLen = (html || '').length;
  const textLen = squish(text || '').length;

  if (!htmlLen) return { needed: true, reason: 'empty response body' };

  // Empty SPA mount point.
  for (const sel of ['#root', '#app', '#__next', '[data-reactroot]', '#__nuxt', 'app-root']) {
    const el = $(sel).first();
    if (el.length && el.children().length === 0 && squish(el.text()).length < 40) {
      return { needed: true, reason: `empty SPA mount point (${sel})` };
    }
  }

  if ($('noscript').text().toLowerCase().includes('enable javascript')) {
    return { needed: true, reason: '<noscript> asks for JavaScript' };
  }

  if (textLen < 500) return { needed: true, reason: `very little visible text (${textLen} chars)` };
  if (htmlLen > 20000 && textLen / htmlLen < 0.06) {
    return { needed: true, reason: `low text-to-markup ratio (${(textLen / htmlLen).toFixed(3)})` };
  }

  const imgCount = $('img').length;
  const lazyCount = $('[data-src], [data-lazy], [data-lazy-src], [data-original], [data-srcset]').length;
  if (imgCount === 0 && lazyCount >= 3) {
    return { needed: true, reason: `${lazyCount} lazy-loaded images and no <img src>` };
  }

  if (signals.requiredFieldsUnresolved) {
    return { needed: true, reason: 'fields unresolved in static HTML — retrying with a browser' };
  }

  return { needed: false, reason: null };
}

/** Lazily-created shared browser, so repeated renders reuse one process. */
export class Renderer {
  constructor({
    timeoutMs = 30000,
    userAgent,
    blockImages = true,
    maxScrolls = 12,
    maxLoadMoreClicks = 3,
    viewport = { width: 1366, height: 900 },
    logger = null,
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.blockImages = blockImages;
    this.maxScrolls = maxScrolls;
    this.maxLoadMoreClicks = maxLoadMoreClicks;
    this.viewport = viewport;
    this.logger = logger;
    this.browser = null;
    this.available = null; // null = untested
    this.unavailableReason = null;
  }

  async ensureBrowser() {
    if (this.browser) return this.browser;
    if (this.available === false) return null;
    try {
      const { chromium } = await import('playwright');
      this.browser = await chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-blink-features=AutomationControlled'],
      });
      this.available = true;
      return this.browser;
    } catch (err) {
      this.available = false;
      this.unavailableReason =
        /Executable doesn't exist|browserType.launch/i.test(err.message)
          ? 'Playwright browser not installed — run `npx playwright install chromium`'
          : `Playwright unavailable: ${err.message}`;
      this.logger?.warn(this.unavailableReason);
      return null;
    }
  }

  /**
   * @returns {Promise<{ok: boolean, html: string, finalUrl: string, status: number,
   *                    error?: string, errorType?: string, warnings: string[]}>}
   */
  async render(url, {
    waitForSelector = null,
    clickLoadMore = false,
    /** Scroll until the page stops growing — infinite-scroll lists. */
    exhaustScroll = false,
    maxLoadMoreClicks = null,
    scrollBudgetMs = 45000,
  } = {}) {
    const warnings = [];
    const browser = await this.ensureBrowser();
    if (!browser) {
      return {
        ok: false, html: '', finalUrl: url, status: 0,
        error: this.unavailableReason, errorType: 'renderer_unavailable', warnings,
      };
    }

    let context;
    let page;
    try {
      context = await browser.newContext({
        userAgent: this.userAgent,
        viewport: this.viewport,
        locale: 'en-US',
        // Many lazy-loaders only fire on a "real" scroll; a normal viewport
        // plus device scale 1 behaves closest to a user.
        deviceScaleFactor: 1,
        ignoreHTTPSErrors: false,
      });

      await context.route('**/*', (route) => {
        const req = route.request();
        const type = req.resourceType();
        const reqUrl = req.url();
        if (BLOCKED_URL_RE.test(reqUrl)) return route.abort();
        if (BLOCKED_TYPES.has(type)) return route.abort();
        // We never need the image bytes — only the URLs in the DOM.
        if (this.blockImages && type === 'image') return route.abort();
        return route.continue();
      });

      page = await context.newPage();
      page.setDefaultTimeout(this.timeoutMs);

      let status = 0;
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.timeoutMs,
      });
      status = response?.status() ?? 0;

      // Network idle is best-effort: an analytics long-poll must not fail us.
      await page.waitForLoadState('networkidle', { timeout: Math.min(8000, this.timeoutMs) })
        .catch(() => warnings.push('networkidle not reached; continued after timeout'));

      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, { timeout: 5000 })
          .catch(() => warnings.push(`waitForSelector "${waitForSelector}" timed out`));
      }

      await settle(page);

      const clickBudget = maxLoadMoreClicks ?? this.maxLoadMoreClicks;

      if (exhaustScroll) {
        // Infinite scroll and "load more" are often the same list: scrolling
        // reveals the button, clicking it appends rows, which makes the page
        // scrollable again. Alternate until neither does anything.
        let totalClicks = 0;
        let rounds = 0;
        let stopped = 'no further growth';
        const started = Date.now();

        for (let pass = 0; pass < 12; pass += 1) {
          const scrolled = await exhaustiveScroll(page, {
            maxMs: Math.max(3000, scrollBudgetMs - (Date.now() - started)),
          });
          rounds += scrolled.rounds;
          stopped = scrolled.stopped;

          if (Date.now() - started > scrollBudgetMs) {
            stopped = `scroll budget (${scrollBudgetMs}ms) reached`;
            break;
          }
          if (totalClicks >= clickBudget) break;
          const clicks = await clickLoadMoreButtons(page, clickBudget - totalClicks);
          totalClicks += clicks;
          if (!clicks) break;
        }

        warnings.push(
          `exhaustive scroll: ${rounds} scroll round(s)` +
            (totalClicks ? `, ${totalClicks} "load more" click(s)` : '') +
            ` — stopped because ${stopped}`,
        );
      } else {
        await autoScroll(page, this.maxScrolls);
        if (clickLoadMore && clickBudget > 0) {
          const clicks = await clickLoadMoreButtons(page, clickBudget);
          if (clicks) warnings.push(`clicked "load more" ${clicks}x`);
        }
      }

      await settle(page);
      // Back to the top: some sites only populate hero/OG content when scrolled up.
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

      const html = await page.content();
      const finalUrl = page.url();
      return { ok: true, html, finalUrl, status: status || 200, warnings };
    } catch (err) {
      // A timeout after partial load still leaves usable HTML — keep it.
      let html = '';
      try {
        html = page ? await page.content() : '';
      } catch { /* page already closed */ }
      const timedOut = /Timeout|timeout/i.test(err.message);
      return {
        ok: html.length > 500,
        html,
        finalUrl: url,
        status: 0,
        error: err.message,
        errorType: timedOut ? 'timeout' : 'render_error',
        warnings: [...warnings, `render error: ${err.message}`],
      };
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
    }
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

/** Wait until the DOM stops changing size, capped. */
async function settle(page, { checks = 3, intervalMs = 350, maxMs = 4000 } = {}) {
  const started = Date.now();
  let previous = -1;
  let stable = 0;
  while (Date.now() - started < maxMs && stable < checks) {
    const size = await page.evaluate(() => document.body?.innerHTML.length ?? 0).catch(() => previous);
    if (size === previous) stable += 1;
    else stable = 0;
    previous = size;
    await page.waitForTimeout(intervalMs);
  }
}

/**
 * Step-scroll to the bottom. Stepping (rather than jumping) is what triggers
 * IntersectionObserver-based lazy loaders and infinite-scroll galleries.
 */
async function autoScroll(page, maxSteps) {
  await page
    .evaluate(async (steps) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let lastHeight = 0;
      for (let i = 0; i < steps; i += 1) {
        const height = document.body.scrollHeight;
        window.scrollTo(0, Math.min(height, (i + 1) * window.innerHeight * 0.9));
        await sleep(250);
        if (height === lastHeight && i > 2) break;
        lastHeight = height;
      }
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(300);
    }, maxSteps)
    .catch(() => {});
}

/**
 * Infinite scroll: keep scrolling to the bottom until the page stops growing.
 *
 * `autoScroll` above exists to trigger lazy *images* on a page of known length,
 * so it is capped and cheap. Infinite scroll is the opposite problem — the page
 * length is unknown and each scroll may fetch another batch — so this version
 * is driven by observed growth and bounded by wall-clock time and a row cap
 * rather than by a step count.
 *
 * Runs step-by-step from Node rather than in one long `evaluate`, so a hung
 * fetch inside the page cannot exceed the budget.
 *
 * @returns {Promise<{rounds: number, stopped: string, height: number}>}
 */
async function exhaustiveScroll(page, { maxMs = 45000, maxRounds = 80, stableRounds = 3, settleMs = 700 } = {}) {
  const started = Date.now();
  let lastHeight = -1;
  let stable = 0;
  let rounds = 0;
  let stopped = 'no further growth';

  while (rounds < maxRounds) {
    if (Date.now() - started > maxMs) {
      stopped = `time budget (${maxMs}ms) reached`;
      break;
    }
    rounds += 1;

    const height = await page
      .evaluate(async (wait) => {
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise((r) => setTimeout(r, wait));
        return document.body.scrollHeight;
      }, settleMs)
      .catch(() => lastHeight);

    if (height === lastHeight) {
      stable += 1;
      if (stable >= stableRounds) break;
    } else {
      stable = 0;
    }
    lastHeight = height;
  }

  if (rounds >= maxRounds) stopped = `scroll round cap (${maxRounds}) reached`;
  return { rounds, stopped, height: lastHeight };
}

/**
 * Click "load more" buttons to expand a list or gallery.
 *
 * Stops on the first click that does not grow the DOM, so a button that is
 * still present but exhausted (or one that opens a modal) cannot spin the loop
 * to its cap.
 */
async function clickLoadMoreButtons(page, maxClicks) {
  const selector =
    'button, a[role="button"], a.btn, a[href="#"], [class*="load-more"], [class*="loadmore"], ' +
    '[class*="show-more"], [class*="view-more"], [class*="more-btn"], [data-load-more]';
  let clicks = 0;

  for (let i = 0; i < maxClicks; i += 1) {
    const before = await page.evaluate(() => document.body.innerHTML.length).catch(() => 0);

    const clicked = await page
      .evaluate((sel) => {
        const re = /load\s*more|show\s*more|view\s*more|see\s*more|more\s*(photos|images|results|items|listings)|next\s*\d+/i;
        const target = [...document.querySelectorAll(sel)].find((el) => {
          const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.className || ''}`;
          if (!re.test(label)) return false;
          if (el.offsetParent === null) return false;
          if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
          return true;
        });
        if (!target) return false;
        target.scrollIntoView({ block: 'center' });
        target.click();
        return true;
      }, selector)
      .catch(() => false);

    if (!clicked) break;
    await settle(page, { checks: 2, maxMs: 4000 });

    const after = await page.evaluate(() => document.body.innerHTML.length).catch(() => before);
    clicks += 1;
    // The click ran but added nothing: the list is exhausted.
    if (after <= before) break;
  }
  return clicks;
}
