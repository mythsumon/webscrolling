/**
 * Relevance-scored internal-link discovery.
 *
 * Only the links that could plausibly hold an *unresolved* field are eligible,
 * which is what keeps this from becoming a crawler. A page with 200 links
 * typically yields 1-3 candidates for a typical label set.
 */

import { PAGE_PRIORS } from '../extract/ontology.js';
import { normalizeUrl, sameSite, looksNonHtml, urlTokens } from '../util/url.js';
import { tokens, tokenOverlap } from '../util/text.js';

/** Query strings that mean "a different slice of the same list". */
const PAGINATION_QUERY_RE = /[?&](page|paged|p|start|offset|sort|order|orderby|filter|view|per_page|limit)=/i;

/** Paths that are never worth a page budget. */
const SKIP_PATH_RE =
  /\/(cart|checkout|basket|login|signin|sign-in|signup|register|account|my-account|wp-admin|wp-login|admin|feed|rss|sitemap|privacy|privacy-policy|terms|terms-of-service|cookie|cookies|disclaimer|legal|search|tag|tags|category|categories|author|comment|share|print|wishlist|compare|subscribe|newsletter)(\/|$|\.)/i;

const LOCALE_RE = /^\/([a-z]{2}(-[a-z]{2})?)(\/|$)/i;

/**
 * @param {import('../core/page.js').PageModel} page
 * @param {import('../extract/labels.js').FieldSpec[]} unresolvedSpecs
 * @param {object} opts
 * @param {Set<string>} opts.visited       normalised URLs already fetched
 * @param {string} opts.rootUrl            the URL the user gave us
 * @param {number} [opts.limit]
 * @param {boolean} [opts.allowPagination] follow ?page= links (list fields only)
 * @returns {Array<{url: string, score: number, reasons: string[], text: string}>}
 */
export function discoverLinks(page, unresolvedSpecs, { visited, rootUrl, limit = 4, allowPagination = false }) {
  if (!unresolvedSpecs.length) return [];

  // Pooled vocabulary of everything we still need.
  const wantKeywords = new Set();
  const wantPageHints = new Set();
  for (const spec of unresolvedSpecs) {
    for (const k of spec.keywords) if (k.length >= 3) wantKeywords.add(k);
    for (const h of spec.pageHints) wantPageHints.add(h);
  }
  const needsListFill = unresolvedSpecs.some((s) => s.plural);

  const scored = [];

  for (const link of page.links) {
    const norm = normalizeUrl(link.url);
    if (visited.has(norm)) continue;
    if (!sameSite(link.url, rootUrl)) continue;
    if (looksNonHtml(link.url)) continue;
    if (/nofollow/i.test(link.rel)) continue;

    let pathname;
    try {
      pathname = new URL(link.url).pathname;
    } catch {
      continue;
    }
    if (SKIP_PATH_RE.test(pathname)) continue;

    const isPagination = PAGINATION_QUERY_RE.test(link.url);
    if (isPagination && !(allowPagination && needsListFill)) continue;

    // Deep paths are usually individual items, not the section page we want.
    const depth = pathname.split('/').filter(Boolean).length;
    const localeAdjusted = LOCALE_RE.test(pathname) ? depth - 1 : depth;
    if (localeAdjusted > 3) continue;

    const reasons = [];
    let score = 0;

    // 1. Path words matching the fields we still need.
    const pathTokens = urlTokens(link.url);
    const pathHits = pathTokens.filter((t) => wantKeywords.has(t));
    if (pathHits.length) {
      score += 0.5 + Math.min(0.3, pathHits.length * 0.12);
      reasons.push(`path matches ${pathHits.slice(0, 3).join('/')}`);
    }

    // 2. Explicit page hints from the ontology ("phone" -> /contact).
    const hintHit = [...wantPageHints].find((h) => pathTokens.includes(h) || pathname.toLowerCase().includes(`/${h}`));
    if (hintHit) {
      score += 0.45;
      reasons.push(`likely page for these fields (/${hintHit})`);
    }

    // 3. Anchor text / title / aria-label.
    const anchorText = `${link.text} ${link.title} ${link.ariaLabel}`.trim();
    const anchorTokens = tokens(anchorText);
    const anchorHits = anchorTokens.filter((t) => wantKeywords.has(t));
    if (anchorHits.length) {
      score += 0.3 + Math.min(0.2, anchorHits.length * 0.1);
      reasons.push(`link text mentions ${anchorHits.slice(0, 3).join('/')}`);
    } else if (anchorTokens.length && tokenOverlap([...wantKeywords], anchorTokens) > 0) {
      score += 0.1;
    }

    // 4. Generic prior for universally useful pages.
    const slug = pathTokens.at(-1) ?? '';
    const prior = PAGE_PRIORS[slug] ?? PAGE_PRIORS[pathTokens.join('-')] ?? 0;
    if (prior) {
      score += prior * 0.35;
      reasons.push(`common section page (/${slug})`);
    }

    // 5. Small bonuses/penalties.
    if (link.inNav) score += 0.06;             // nav links are section pages
    if (localeAdjusted === 1) score += 0.05;   // top-level sections
    if (isPagination) {
      score += 0.2;
      reasons.push('pagination for an unfilled list field');
    }
    if (!anchorText && !pathHits.length && !hintHit) score -= 0.2;

    if (score < 0.3) continue;
    scored.push({ url: link.url, normalized: norm, score, reasons, text: link.text });
  }

  // One entry per normalised URL, best score wins.
  const byUrl = new Map();
  for (const s of scored) {
    const prev = byUrl.get(s.normalized);
    if (!prev || s.score > prev.score) byUrl.set(s.normalized, s);
  }

  return [...byUrl.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/* --------------------------------------------------------- pagination */

/** Ways a page number is carried in a URL. */
const PAGE_NUMBER_PATTERNS = [
  { re: /([?&](?:page|paged|pg|pagenum|page_num|pageno|page_number)=)(\d+)/i, kind: 'query' },
  { re: /(\/(?:page|pages|p)\/)(\d+)/i, kind: 'path' },
  { re: /([?&]p=)(\d+)/i, kind: 'query' },
  { re: /(-page-)(\d+)/i, kind: 'slug' },
  { re: /([?&](?:start|offset|from|skip)=)(\d+)/i, kind: 'offset' },
];

/** Link text / aria-label that means "the next page". */
const NEXT_TEXT_RE =
  /^(next|next\s*page|older|more|forward|›|»|→|▶|>>|>|»|›)$/i;
const NEXT_ATTR_RE = /(^|[\s_-])(next|nextpage|pagination-next|page-next|forward)([\s_-]|$)/i;
const PREV_RE = /(prev|previous|back|earlier|newer|‹|«|←|◀|<<)/i;
const DISABLED_RE = /(disabled|inactive|is-active|current|active)/i;

/**
 * Read the page number out of a URL.
 * @returns {{number: number, prefix: string, suffix: string, kind: string}|null}
 */
export function parsePageNumber(url) {
  for (const { re, kind } of PAGE_NUMBER_PATTERNS) {
    const m = String(url).match(re);
    if (!m) continue;
    const number = Number(m[2]);
    if (!Number.isFinite(number)) continue;
    return { number, prefix: m[1], suffix: '', kind, matched: m[0] };
  }
  return null;
}

/**
 * The next page of a list, or null when there is none.
 *
 * Four strategies, strongest first. The numbered strategy is the one that
 * matters in practice: plenty of directories render `1 2 3 … Next` where the
 * "Next" anchor is an icon with no text, so matching on text alone stalls on
 * page 1. Knowing we are on page N and looking for a link to N+1 does not care
 * how the control is labelled.
 *
 * @param {import('../core/page.js').PageModel} page
 * @param {{visited: Set<string>, rootUrl: string}} ctx
 * @returns {{url: string, reasons: string[], text: string}|null}
 */
export function discoverNextPage(page, { visited, rootUrl }) {
  const usable = (url) => {
    if (!url) return false;
    if (!sameSite(url, rootUrl) || looksNonHtml(url)) return false;
    return !visited.has(normalizeUrl(url));
  };

  // 1. <link rel="next"> or <a rel="next">.
  const relNext = page.links.find((l) => /(^|\s)next(\s|$)/i.test(l.rel) && usable(l.url));
  if (relNext) {
    return { url: relNext.url, reasons: ['rel="next"'], text: relNext.text };
  }
  const headNext = page.meta['link:next'];
  if (headNext) {
    const abs = new URL(headNext, page.finalUrl).toString();
    if (usable(abs)) return { url: abs, reasons: ['<link rel="next">'], text: 'next' };
  }

  // 2. Numbered pagination: we are on N, so find the link to N+1.
  const current = parsePageNumber(page.finalUrl) ?? parsePageNumber(page.url);
  const currentNumber = current?.number ?? 1;
  const wanted = current?.kind === 'offset' ? null : currentNumber + 1;

  if (wanted != null) {
    const numbered = page.links
      .map((l) => ({ link: l, parsed: parsePageNumber(l.url) }))
      .filter(({ link, parsed }) => parsed && parsed.number === wanted && usable(link.url));
    if (numbered.length) {
      const { link } = numbered[0];
      return {
        url: link.url,
        reasons: [`numbered pagination: page ${wanted}`],
        text: link.text || String(wanted),
      };
    }
  }

  // 3. An explicit next control, by text or by attribute.
  const nextish = page.links.find((l) => {
    if (!usable(l.url)) return false;
    const text = (l.text || '').trim();
    const attrs = `${l.className} ${l.rel}`;
    if (PREV_RE.test(`${text} ${attrs} ${l.ariaLabel} ${l.title}`)) return false;
    const looksNext =
      NEXT_TEXT_RE.test(text) ||
      NEXT_ATTR_RE.test(attrs) ||
      NEXT_TEXT_RE.test((l.ariaLabel || '').trim()) ||
      NEXT_TEXT_RE.test((l.title || '').trim());
    if (!looksNext) return false;
    // "Next" on the last page is usually rendered disabled.
    return !DISABLED_RE.test(l.className);
  });
  if (nextish) {
    return { url: nextish.url, reasons: ['a "next" control'], text: nextish.text };
  }

  // 4. Offset pagination (`?start=20`): step by the stride we can infer.
  if (current?.kind === 'offset') {
    const others = page.links
      .map((l) => parsePageNumber(l.url))
      .filter((p) => p?.kind === 'offset' && p.number > current.number)
      .sort((a, b) => a.number - b.number);
    if (others.length) {
      const target = others[0];
      const url = String(page.finalUrl).replace(current.matched, `${current.prefix}${target.number}`);
      if (usable(url)) {
        return { url, reasons: [`offset pagination: start=${target.number}`], text: String(target.number) };
      }
    }
  }

  return null;
}

/**
 * Does this page look like it is paginated at all? Used to explain why a walk
 * stopped after one page.
 */
export function hasPaginationControls(page) {
  return page.links.some(
    (l) =>
      parsePageNumber(l.url) ||
      /(^|\s)(next|prev)(\s|$)/i.test(l.rel) ||
      /pagination|pager|page-numbers/i.test(l.className),
  );
}
