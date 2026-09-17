/**
 * The orchestrator (ARCHITECTURE.md §4).
 *
 * Owns the page budget. The loop invariant is: we only ever fetch another page
 * if there is still an unresolved field that page might plausibly contain.
 */

import { Fetcher, DEFAULT_USER_AGENT } from './fetcher.js';
import { Renderer, needsRendering } from './renderer.js';
import { RobotsGate } from './robots.js';
import { buildPageModel, pageDigest } from './page.js';
import { detectRestriction, detectLoginWall } from './guards.js';
import { parseLabels } from '../extract/labels.js';
import { resolveField } from '../extract/resolvers.js';
import { resolveWithLlm } from '../extract/llm.js';
import { discoverLinks, discoverNextPage, hasPaginationControls } from '../links/discovery.js';
import { extractRecords } from '../extract/records.js';
import { assembleResult, assembleListResult, errorResult } from '../output/result.js';
import { validateUrl, normalizeUrl } from '../util/url.js';
import { createLogger } from '../util/logger.js';

/** @typedef {import('../extract/labels.js').FieldSpec} FieldSpec */

export const DEFAULT_OPTIONS = {
  /**
   * 'single' -> one record describing the page (a hotel's own homepage).
   * 'list'   -> one record per repeated item (a directory or results page).
   * 'auto'   -> try list first; fall back to single when the page has no
   *             repeating structure that answers the requested labels.
   */
  mode: 'auto',
  maxRecords: 200,
  minFieldsPerRecord: 2,
  maxPages: 5,
  maxDepth: 1,
  followInternalLinks: true,
  /** Walk `?page=2`, `/page/3/`, "Next ›" and concatenate the records. */
  allowPagination: false,
  /** Extra list pages beyond the first. `'all'` or Infinity = until exhausted. */
  maxPaginationPages: 2,
  /**
   * Scroll a rendered page until it stops growing, and keep clicking "load
   * more". This is the infinite-scroll counterpart to `allowPagination`.
   */
  exhaustScroll: false,
  maxLoadMoreClicks: 3,
  scrollBudgetMs: 45000,
  render: 'auto',            // 'auto' | 'always' | 'never'
  renderTimeoutMs: 30000,
  requestTimeoutMs: 20000,
  minDelayMs: 1200,
  obeyRobots: true,
  useLlm: false,
  llmModel: undefined,
  minConfidence: 0.4,
  maxListItems: 40,
  clickLoadMore: false,
  userAgent: DEFAULT_USER_AGENT,
  logLevel: 'silent',
};

/**
 * Extract user-defined labels from a website.
 *
 * @param {object} input
 * @param {string} input.url
 * @param {string[]} input.labels
 * @param {Partial<typeof DEFAULT_OPTIONS>} [input.options]
 * @param {Renderer} [input.renderer]  reuse a browser across calls
 * @returns {Promise<object>} the result object from output/result.js
 */
export async function scrape({ url, labels, options: userOptions = {}, renderer: sharedRenderer } = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  const logger = createLogger(options.logLevel);

  const specs = parseLabels(labels);
  const warnings = [];
  const errors = [];

  const validated = validateUrl(url);
  if (!validated.ok) {
    return errorResult({
      url: String(url ?? ''),
      specs,
      error: { type: 'invalid_url', message: validated.reason },
    });
  }
  if (!specs.length) {
    return errorResult({
      url: validated.url,
      specs,
      error: { type: 'no_labels', message: 'No labels were provided — nothing to extract.' },
    });
  }

  const rootUrl = validated.url;
  const fetcher = new Fetcher({
    userAgent: options.userAgent,
    timeoutMs: options.requestTimeoutMs,
    minDelayMs: options.minDelayMs,
    logger,
  });
  const robots = new RobotsGate({
    fetchText: fetcher.fetchText,
    userAgent: options.userAgent,
    enabled: options.obeyRobots,
    logger,
  });
  if (!options.obeyRobots) {
    warnings.push('robots.txt checking is DISABLED for this run (obeyRobots: false).');
  }

  const renderer =
    sharedRenderer ??
    new Renderer({
      timeoutMs: options.renderTimeoutMs,
      userAgent: options.userAgent,
      maxLoadMoreClicks: options.clickLoadMore ? 3 : 0,
      logger,
    });
  const ownsRenderer = !sharedRenderer;

  /** @type {Record<string, object[]>} */
  const candidates = {};
  const pagesVisited = [];
  const visited = new Set();
  /** @type {Array<{url: string, digest: string}>} */
  const digests = [];
  /** @type {Array<{url: string, depth: number, reasons: string[]}>} */
  const queue = [{ url: rootUrl, depth: 0, reasons: ['user-provided URL'] }];
  let paginationUsed = 0;

  try {
    // --- list mode -----------------------------------------------------
    // A listing page must be handled before the single-record loop, because
    // the two want opposite things: the loop would wander off to /contact to
    // "find the missing phone number", when the phone numbers are all right
    // here, one per row.
    if (options.mode === 'list' || options.mode === 'auto') {
      const list = await runListMode({
        rootUrl, specs, fetcher, robots, renderer, options, logger, visited, warnings, errors,
      });
      if (list) return list;
      if (options.mode === 'list') {
        return assembleListResult({
          url: rootUrl,
          specs,
          records: [],
          pagesVisited: [],
          errors,
          warnings: [
            ...warnings,
            'No repeating list structure on this page yielded the requested labels. If this is a single-subject page, use mode "single".',
          ],
          options,
        });
      }
      logger.info('no list structure found — falling back to single-record extraction');
      // `visited` is intentionally cleared: the root page is about to be
      // fetched again by the single-record loop, and the fetcher's per-host
      // queue already rate-limits that second request.
      visited.clear();
    }

    while (queue.length && pagesVisited.length < options.maxPages) {
      const job = queue.shift();
      const norm = normalizeUrl(job.url);
      if (visited.has(norm)) continue;
      visited.add(norm);

      const outcome = await fetchPage({ job, fetcher, robots, renderer, options, logger });
      for (const w of outcome.warnings) warnings.push(w);
      for (const e of outcome.errors) errors.push(e);
      if (!outcome.page) continue;

      let page = outcome.page;

      // Resolve every field on this page; later pages can still improve a value.
      let pageCandidates = resolveAll(page, specs);

      // Retry with a browser when the static HTML left fields unresolved. This
      // is the render trigger that matters most: it is driven by whether we
      // actually got the data, not by guessing about the framework.
      if (
        options.render === 'auto' &&
        page.renderer === 'static' &&
        renderer.available !== false &&
        wouldStillBeMissing(specs, candidates, pageCandidates, options.minConfidence) > 0
      ) {
        const decision = needsRendering(page, { requiredFieldsUnresolved: true });
        logger.info(`re-rendering ${job.url}: ${decision.reason}`);
        const rendered = await renderer.render(job.url, { clickLoadMore: options.clickLoadMore });
        warnings.push(...rendered.warnings.map((w) => `${job.url}: ${w}`));
        if (rendered.ok && rendered.html.length > page.html.length * 0.5) {
          const rerendered = buildPageModel({
            html: rendered.html,
            url: job.url,
            finalUrl: rendered.finalUrl,
            status: rendered.status || page.status,
            renderer: 'playwright',
          });
          const reresolved = resolveAll(rerendered, specs);
          // Only keep the rendered version if it actually helped.
          if (totalGood(reresolved, options.minConfidence) >= totalGood(pageCandidates, options.minConfidence)) {
            page = rerendered;
            pageCandidates = reresolved;
          }
        } else if (!rendered.ok) {
          warnings.push(
            `${job.url}: ${rendered.error ?? 'rendering failed'} — using static HTML (JavaScript-only content may be missing).`,
          );
        }
      }

      for (const [key, list] of Object.entries(pageCandidates)) {
        (candidates[key] ??= []).push(...list);
      }

      pagesVisited.push({
        url: job.url,
        final_url: page.finalUrl,
        status: page.status,
        renderer: page.renderer,
        depth: job.depth,
        reasons: job.reasons,
      });
      digests.push({ url: page.finalUrl, digest: pageDigest(page) });

      const unresolved = unresolvedSpecs(specs, candidates, options.minConfidence);
      if (!unresolved.length) {
        logger.info('all labels resolved — stopping early');
        break;
      }

      // Under-filled list fields can justify one more page of the same list.
      if (options.allowPagination && paginationUsed < options.maxPaginationPages) {
        const next = discoverNextPage(page, { visited, rootUrl });
        if (next && unresolved.some((s) => s.plural)) {
          paginationUsed += 1;
          queue.push({ url: next.url, depth: job.depth, reasons: next.reasons });
        }
      }

      if (!options.followInternalLinks || job.depth >= options.maxDepth) continue;

      const budgetLeft = options.maxPages - pagesVisited.length - queue.length;
      if (budgetLeft <= 0) continue;

      const links = discoverLinks(page, unresolved, {
        visited,
        rootUrl,
        limit: Math.min(budgetLeft, 4),
        allowPagination: options.allowPagination,
      });
      for (const link of links) {
        logger.info(`queueing ${link.url} (${link.score.toFixed(2)}): ${link.reasons.join('; ')}`);
        queue.push({ url: link.url, depth: job.depth + 1, reasons: link.reasons });
      }
    }

    if (!pagesVisited.length) {
      return errorResult({
        url: rootUrl,
        specs,
        error: errors.length ? errors : [{ type: 'fetch_failed', message: 'No page could be retrieved.' }],
        warnings,
      });
    }

    // Tier 5, on whatever is still missing.
    const stillMissing = unresolvedSpecs(specs, candidates, options.minConfidence);
    if (options.useLlm && stillMissing.length) {
      logger.info(`LLM pass for ${stillMissing.length} unresolved label(s)`);
      const llm = await resolveWithLlm({
        specs: stillMissing,
        pages: digests,
        options: { model: options.llmModel, apiKey: options.anthropicApiKey },
      });
      for (const [key, list] of Object.entries(llm.candidates)) {
        (candidates[key] ??= []).push(...list);
      }
      warnings.push(...llm.warnings);
      errors.push(...llm.errors);
    } else if (stillMissing.length && !options.useLlm) {
      logger.debug(`${stillMissing.length} label(s) unresolved; LLM matching is off`);
    }

    return assembleResult({
      url: rootUrl,
      specs,
      candidates,
      pagesVisited,
      errors,
      warnings,
      options,
    });
  } finally {
    if (ownsRenderer) await renderer.close();
  }
}

/**
 * Fetch one page: robots gate -> static fetch -> restriction check ->
 * render if needed -> PageModel.
 */
/**
 * @param {object} args
 * @param {object} [args.renderOptions] passed through to `renderer.render`, so a
 *   caller that already knows it wants exhaustive scrolling gets it on the
 *   *first* render instead of rendering twice.
 */
async function fetchPage({ job, fetcher, robots, renderer, options, logger, renderOptions = {} }) {
  const warnings = [];
  const errors = [];
  const renderArgs = { clickLoadMore: options.clickLoadMore, ...renderOptions };

  const gate = await robots.check(job.url);
  if (!gate.allowed) {
    errors.push({
      type: 'robots_disallowed',
      url: job.url,
      message: `Skipped ${job.url}: disallowed by robots.txt. Not overriding site policy.`,
    });
    return { page: null, warnings, errors };
  }
  if (gate.crawlDelay) fetcher.setHostDelay(job.url, gate.crawlDelay);

  let html = '';
  let finalUrl = job.url;
  let status = 0;
  let usedRenderer = 'static';

  if (options.render === 'always') {
    const rendered = await renderer.render(job.url, renderArgs);
    warnings.push(...rendered.warnings.map((w) => `${job.url}: ${w}`));
    if (rendered.ok) {
      ({ html, finalUrl } = rendered);
      status = rendered.status;
      usedRenderer = 'playwright';
    } else {
      warnings.push(`${job.url}: rendering failed (${rendered.error}); falling back to static fetch.`);
    }
  }

  if (!html) {
    const res = await fetcher.get(job.url);
    status = res.status;
    finalUrl = res.finalUrl;
    html = res.body ?? '';
    if (!res.ok && !html) {
      errors.push({
        type: res.errorType ?? 'fetch_failed',
        url: job.url,
        status: res.status,
        message: `${job.url}: ${res.error ?? 'request failed'}`,
      });
      return { page: null, warnings, errors };
    }
    if (!res.ok) {
      warnings.push(`${job.url}: ${res.error} — parsing the body anyway.`);
    }
    if (res.contentType && !/html|xml|text\/plain/i.test(res.contentType)) {
      warnings.push(`${job.url}: unexpected content-type "${res.contentType}"; skipped.`);
      return { page: null, warnings, errors };
    }
  }

  let page = buildPageModel({ html, url: job.url, finalUrl, status, renderer: usedRenderer });

  // Restriction checks happen on whatever we got — reported, never bypassed.
  const restriction = detectRestriction({ status, html: page.html, text: page.text }) ??
    detectLoginWall(page.$, page.text);
  if (restriction) {
    errors.push({ type: restriction.type, url: job.url, message: `${job.url}: ${restriction.message}` });
    // A challenge page has no usable content; do not pretend otherwise.
    if (restriction.type === 'captcha' || restriction.type === 'login_required') {
      return { page: null, warnings, errors };
    }
  }

  // Structural render trigger: the static HTML is visibly inert (empty SPA
  // mount, no text, lazy-only images). The data-driven trigger lives in the
  // main loop, after we know which fields the static HTML could not answer.
  if (options.render === 'auto' && usedRenderer === 'static') {
    const decision = needsRendering(page);
    if (decision.needed) {
      logger.info(`rendering ${job.url}: ${decision.reason}`);
      const rendered = await renderer.render(job.url, renderArgs);
      warnings.push(...rendered.warnings.map((w) => `${job.url}: ${w}`));
      if (rendered.ok && rendered.html.length > page.html.length * 0.5) {
        page = buildPageModel({
          html: rendered.html,
          url: job.url,
          finalUrl: rendered.finalUrl,
          status: rendered.status || status,
          renderer: 'playwright',
        });
      } else if (!rendered.ok) {
        warnings.push(
          `${job.url}: ${rendered.error ?? 'rendering failed'} — using static HTML (JavaScript-only content may be missing).`,
        );
      }
    }
  }

  return { page, warnings, errors };
}

/**
 * Extract one record per repeated item on the page.
 *
 * @returns {Promise<object|null>} a list result, or null when the page has no
 *   repeating structure that answers the labels (so 'auto' can fall back).
 */
async function runListMode({
  rootUrl, specs, fetcher, robots, renderer, options, logger, visited, warnings, errors,
}) {
  const pagesVisited = [];
  /** @type {Array<object>} */
  const records = [];
  let group = null;
  const listWarnings = [];

  // Page budget. Deliberately NOT capped by `maxPages`, which governs
  // link-following breadth in single mode — silently clipping a 40-page walk
  // to 5 because of an unrelated default would be a trap. `maxRecords` and the
  // hard cap below are the real safety nets.
  const extraPages = paginationBudget(options);
  const pageBudget = 1 + extraPages;

  // Global dedupe across pages: many sites repeat the last row, or serve the
  // same rows when asked for a page past the end.
  const seen = new Set();
  const identityOf = (record) => specs.map((s) => JSON.stringify(record.data[s.key])).join('|');

  let job = { url: rootUrl, reasons: ['user-provided URL'] };
  let stopReason = 'no further pages';

  while (job) {
    const norm = normalizeUrl(job.url);
    if (visited.has(norm)) {
      stopReason = 'next page was one already visited (pagination loop)';
      break;
    }
    visited.add(norm);

    const wantScroll = options.exhaustScroll && options.render !== 'never';

    const outcome = await fetchPage({
      job, fetcher, robots, renderer, options, logger,
      // If we already know we want to scroll this list, say so now: otherwise
      // `fetchPage`'s own structural render runs without scrolling, comes back
      // with the first batch, and the scroll pass below is skipped because the
      // page is no longer "static".
      renderOptions: wantScroll
        ? {
          exhaustScroll: true,
          clickLoadMore: true,
          maxLoadMoreClicks: options.maxLoadMoreClicks,
          scrollBudgetMs: options.scrollBudgetMs,
        }
        : {},
    });
    warnings.push(...outcome.warnings);
    errors.push(...outcome.errors);
    if (!outcome.page) {
      stopReason = `page ${pagesVisited.length + 1} could not be fetched`;
      break;
    }

    let page = outcome.page;
    let extracted = extractRecords(page, specs, options);

    // Rendering serves two different needs here.
    //  - No rows at all: either this is not a list, or the list is built by
    //    JavaScript. Rendering tells us which.
    //  - `exhaustScroll`: the static HTML holds the first batch only, so we
    //    render even though extraction already succeeded — scrolling is the
    //    only way to reach the rest.
    const needsRender = !extracted.records.length || wantScroll;

    if (needsRender && options.render !== 'never' && page.renderer === 'static' && renderer.available !== false) {
      logger.info(
        `rendering ${job.url}: ${extracted.records.length ? 'scrolling for more rows' : 'no list rows in static HTML'}`,
      );
      const rendered = await renderer.render(job.url, {
        clickLoadMore: options.clickLoadMore || wantScroll,
        exhaustScroll: wantScroll,
        maxLoadMoreClicks: options.maxLoadMoreClicks,
        scrollBudgetMs: options.scrollBudgetMs,
      });
      warnings.push(...rendered.warnings.map((w) => `${job.url}: ${w}`));
      if (rendered.ok && rendered.html.length > page.html.length * 0.5) {
        const rerendered = buildPageModel({
          html: rendered.html,
          url: job.url,
          finalUrl: rendered.finalUrl,
          status: rendered.status || page.status,
          renderer: 'playwright',
        });
        const reextracted = extractRecords(rerendered, specs, options);
        // Keep the rendered page only if it actually produced more rows.
        if (reextracted.records.length >= extracted.records.length && reextracted.records.length) {
          page = rerendered;
          extracted = reextracted;
        }
      }
    }

    if (!extracted.records.length) {
      // Only the first page deciding "not a list" is meaningful; a later
      // pagination page with no rows just ends the walk.
      if (!pagesVisited.length) return null;
      stopReason = `page ${pagesVisited.length + 1} contained no list rows`;
      break;
    }

    // Append, deduping globally.
    let added = 0;
    for (const record of extracted.records) {
      const id = identityOf(record);
      if (seen.has(id)) continue;
      seen.add(id);
      records.push(record);
      added += 1;
      if (records.length >= options.maxRecords) break;
    }

    pagesVisited.push({
      url: job.url,
      final_url: page.finalUrl,
      status: page.status,
      renderer: page.renderer,
      reasons: job.reasons,
      records_found: extracted.records.length,
      records_added: added,
    });
    group = group ?? extracted.group;
    listWarnings.push(...extracted.warnings);

    if (records.length >= options.maxRecords) {
      stopReason = `record cap (maxRecords: ${options.maxRecords}) reached`;
      break;
    }
    // A page whose every row we already had means the site is serving the same
    // slice again — following further would loop.
    if (added === 0 && pagesVisited.length > 1) {
      stopReason = 'a page repeated rows already collected';
      break;
    }
    if (!options.allowPagination) {
      stopReason = hasPaginationControls(page)
        ? 'this page is paginated, but pagination following is off (allowPagination)'
        : 'no further pages';
      break;
    }
    if (pagesVisited.length >= pageBudget) {
      stopReason = `page budget (${pageBudget} list page(s)) reached`;
      break;
    }

    const next = discoverNextPage(page, { visited, rootUrl });
    if (!next) {
      stopReason = hasPaginationControls(page)
        ? 'reached the last page (no further "next" link)'
        : 'no pagination controls on this page';
      break;
    }
    logger.info(`pagination: page ${pagesVisited.length + 1} -> ${next.url} (${next.reasons.join('; ')})`);
    job = { url: next.url, reasons: next.reasons };
  }

  if (!records.length) return null;

  logger.info(
    `list mode: ${records.length} records from ${pagesVisited.length} page(s) — stopped: ${stopReason}`,
  );

  return assembleListResult({
    url: rootUrl,
    specs,
    records,
    pagesVisited,
    group,
    pagination: {
      enabled: Boolean(options.allowPagination),
      pages_walked: pagesVisited.length,
      page_budget: Number.isFinite(pageBudget) ? pageBudget : 'unlimited',
      scrolled: Boolean(options.exhaustScroll),
      stopped_because: stopReason,
    },
    errors,
    warnings: [...warnings, ...listWarnings],
    options,
  });
}

/** How many extra list pages may we walk? */
function paginationBudget(options) {
  if (!options.allowPagination) return 0;
  const raw = options.maxPaginationPages;
  // 'all' / Infinity / 0 mean "until exhausted" — still bounded by maxRecords
  // and by this hard cap, so a pagination loop cannot run forever.
  const HARD_CAP = 500;
  if (raw === 'all' || raw === Infinity || raw === 0 || raw == null) return HARD_CAP;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, HARD_CAP) : 0;
}

/** Resolve every spec against one page. @returns {Record<string, object[]>} */
function resolveAll(page, specs) {
  /** @type {Record<string, object[]>} */
  const out = {};
  for (const spec of specs) {
    const found = resolveField(page, spec);
    if (found.length) out[spec.key] = found;
  }
  return out;
}

function totalGood(pageCandidates, minConfidence) {
  let n = 0;
  for (const list of Object.values(pageCandidates)) {
    if (list.some((c) => c.confidence >= minConfidence)) n += 1;
  }
  return n;
}

/** How many specs would still have no acceptable value after this page? */
function wouldStillBeMissing(specs, candidates, pageCandidates, minConfidence) {
  let missing = 0;
  for (const spec of specs) {
    const pool = [...(candidates[spec.key] ?? []), ...(pageCandidates[spec.key] ?? [])];
    if (!pool.some((c) => c.confidence >= minConfidence)) missing += 1;
  }
  return missing;
}

/** Specs with no candidate at or above the confidence floor. */
function unresolvedSpecs(specs, candidates, minConfidence) {
  return specs.filter((spec) => {
    const pool = candidates[spec.key] ?? [];
    const good = pool.filter((c) => c.confidence >= minConfidence);
    if (!good.length) return true;
    // A list field with a single item is probably incomplete; keep looking,
    // but it is not "missing" in the output.
    if (spec.plural && good.length < 2) return true;
    return false;
  });
}

