/**
 * PageModel: everything the resolvers need from one page, computed once.
 *
 * Building this eagerly (rather than querying the DOM per field) matters when
 * a user asks for 15 labels — the label-proximity search would otherwise walk
 * the document 15 times.
 */

import * as cheerio from 'cheerio';
import { parseJsonLd, parseMicrodata, parseMeta, buildStructuredIndex } from '../extract/structured.js';
import { harvestImages } from '../extract/images.js';
import { absolutize, normalizeUrl } from '../util/url.js';
import { squish, squishBlock, truncate } from '../util/text.js';

/** Elements whose text is never page content. */
const NON_CONTENT = 'script, style, noscript, template, svg, iframe, object, embed';

/** Containers whose text is site chrome rather than page content. */
const BOILERPLATE_SELECTOR =
  'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], ' +
  '.nav, .navbar, .navigation, .menu, .site-header, .site-footer, .footer, .header, ' +
  '.breadcrumb, .breadcrumbs, .cookie, .cookie-banner, .newsletter, .sidebar, .widget-area';

/**
 * @typedef {object} PageModel
 * @property {import('cheerio').CheerioAPI} $
 * @property {string} url          the URL we asked for
 * @property {string} finalUrl     after redirects / <base href>
 * @property {number} status
 * @property {'static'|'playwright'} renderer
 * @property {string} html
 * @property {string} text         visible text, content areas prioritised
 * @property {string} title
 * @property {Record<string,string>} meta
 * @property {object[]} jsonld
 * @property {object[]} microdata
 * @property {{entries: object[], entities: object[]}} structuredIndex
 * @property {object[]} images
 * @property {object[]} links
 * @property {object[]} pairs      label/value pairs found in the DOM
 * @property {object[]} blocks     visible text blocks with selectors
 * @property {Set<string>} boilerplate  normalised chrome strings
 */

/**
 * @param {object} input
 * @param {string} input.html
 * @param {string} input.url
 * @param {string} [input.finalUrl]
 * @param {number} [input.status]
 * @param {'static'|'playwright'} [input.renderer]
 * @returns {PageModel}
 */
export function buildPageModel({ html, url, finalUrl = url, status = 200, renderer = 'static' }) {
  const $ = cheerio.load(html ?? '');

  // <base href> wins over the response URL for resolving relative links.
  const baseHref = $('base[href]').first().attr('href');
  const baseUrl = (baseHref && absolutize(baseHref, finalUrl)) || finalUrl;

  const meta = parseMeta($);
  const jsonld = parseJsonLd($);
  const microdata = parseMicrodata($);
  const structuredIndex = buildStructuredIndex({ jsonld, microdata });

  // Work on a clone for text extraction so image/link harvesting still sees
  // the full document.
  const $text = cheerio.load(html ?? '');
  $text(NON_CONTENT).remove();

  const boilerplate = collectBoilerplate($text);
  const blocks = collectBlocks($text);
  const text = squishBlock(
    blocks
      .filter((b) => !b.boilerplate)
      .map((b) => b.text)
      .join('\n'),
  ) || squishBlock($text('body').text());

  const images = harvestImages($, { baseUrl, meta, structuredIndex });
  const links = collectLinks($, baseUrl);
  const pairs = collectPairs($text, blocks);

  return {
    $,
    url,
    finalUrl: baseUrl,
    status,
    renderer,
    html: html ?? '',
    text,
    title: squish($('title').first().text()),
    meta,
    jsonld,
    microdata,
    structuredIndex,
    images,
    links,
    pairs,
    blocks,
    boilerplate,
  };
}

/**
 * A PageModel restricted to one element's subtree — the unit of list-record
 * extraction.
 *
 * Implemented by re-parsing the element's own HTML rather than by teaching
 * every collector about a root, which keeps one code path for pages and
 * records. It also drops page-level `<meta>` and JSON-LD for free, and that
 * matters: without it every record in a list inherits the site's `og:image`
 * and `og:title`, which is exactly how a listing page ends up reporting the
 * site logo as each business's photo.
 *
 * @param {PageModel} page
 * @param {any} el  cheerio element from `page.$`
 * @returns {PageModel}
 */
export function buildScopeModel(page, el) {
  return buildPageModel({
    html: page.$.html(el) ?? '',
    url: page.url,
    finalUrl: page.finalUrl,
    status: page.status,
    renderer: page.renderer,
  });
}

function collectBoilerplate($) {
  const set = new Set();
  $(BOILERPLATE_SELECTOR).each((_, el) => {
    const t = squish($(el).text());
    if (t) set.add(t.toLowerCase());
  });
  return set;
}

/** Short selector string for provenance. */
function selectorFor($, el) {
  const $el = $(el);
  const tag = ($el.prop('tagName') || 'node').toLowerCase();
  const id = $el.attr('id');
  if (id) return `${tag}#${id}`;
  const cls = ($el.attr('class') || '').split(/\s+/).filter(Boolean).slice(0, 2);
  return cls.length ? `${tag}.${cls.join('.')}` : tag;
}

/**
 * Visible text blocks, each tagged with whether it sits in site chrome and
 * how deep it is (shallow + long = likely main content).
 */
function collectBlocks($) {
  const blocks = [];
  const selector =
    'h1, h2, h3, h4, h5, h6, p, li, dd, dt, td, th, address, figcaption, blockquote, ' +
    'span, div, a, strong, b, em, label, time, small';

  $(selector).each((_, el) => {
    const $el = $(el);
    // Only take elements whose own text is not just their children's text,
    // otherwise every ancestor div duplicates the whole page.
    const own = squish(
      $el
        .contents()
        .filter((__, n) => n.type === 'text')
        .text(),
    );
    const full = squish($el.text());
    const tag = ($el.prop('tagName') || '').toLowerCase();
    const isLeafish = $el.children().length === 0;
    const textToUse = isLeafish || own.length > 0 ? (isLeafish ? full : own) : '';
    if (!textToUse || textToUse.length > 3000) return;

    const inChrome = $el.closest(BOILERPLATE_SELECTOR).length > 0;
    blocks.push({
      text: textToUse,
      full,
      tag,
      selector: selectorFor($, el),
      className: squish($el.attr('class') || ''),
      id: squish($el.attr('id') || ''),
      itemprop: squish($el.attr('itemprop') || ''),
      boilerplate: inChrome,
      depth: $el.parents().length,
      el,
    });
  });
  return blocks;
}

function collectLinks($, baseUrl) {
  const links = [];
  const seen = new Set();
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const abs = absolutize($el.attr('href'), baseUrl);
    if (!abs) return;
    const key = normalizeUrl(abs);
    const text = squish($el.text());
    if (seen.has(key)) {
      // Keep the most descriptive anchor text for a repeated URL.
      const prev = links.find((l) => l.key === key);
      if (prev && text.length > prev.text.length) prev.text = text;
      return;
    }
    seen.add(key);
    links.push({
      url: abs,
      key,
      text,
      title: squish($el.attr('title') || ''),
      ariaLabel: squish($el.attr('aria-label') || ''),
      rel: squish($el.attr('rel') || ''),
      className: squish($el.attr('class') || ''),
      inNav: $el.closest('nav, [role="navigation"], .nav, .navbar, .menu').length > 0,
    });
  });
  return links;
}

/**
 * Label/value pairs, the backbone of tier-4 extraction. Four shapes:
 *   <dt>Phone</dt><dd>+95…</dd>
 *   <th>Phone</th><td>+95…</td>
 *   <label>Phone</label><span>+95…</span>   (also <strong>, <b>, <span class=label>)
 *   "Phone: +95…"                            (single text node)
 */
function collectPairs($, blocks) {
  const pairs = [];
  const push = (label, value, selector, kind, boilerplate) => {
    const l = squish(label).replace(/[:：\-–—]\s*$/, '');
    const v = squish(value);
    if (!l || !v || l.length > 60 || v.length > 500) return;
    if (l.toLowerCase() === v.toLowerCase()) return;
    pairs.push({ label: l, value: v, selector, kind, boilerplate });
  };

  $('dl').each((_, dl) => {
    const children = $(dl).children();
    let currentLabel = null;
    children.each((__, child) => {
      const tag = ($(child).prop('tagName') || '').toLowerCase();
      if (tag === 'dt') currentLabel = squish($(child).text());
      else if (tag === 'dd' && currentLabel) {
        push(currentLabel, $(child).text(), selectorFor($, child), 'dl',
          $(child).closest(BOILERPLATE_SELECTOR).length > 0);
      }
    });
  });

  $('tr').each((_, tr) => {
    const cells = $(tr).children('th, td');
    if (cells.length === 2) {
      push(
        $(cells[0]).text(),
        $(cells[1]).text(),
        selectorFor($, cells[1]),
        'table',
        $(tr).closest(BOILERPLATE_SELECTOR).length > 0,
      );
    }
  });

  // Label-ish element followed by a sibling holding the value.
  $('label, strong, b, dt, .label, [class*="label"], [class*="title"], h3, h4, h5, h6').each((_, el) => {
    const $el = $(el);
    const label = squish($el.text());
    if (!label || label.length > 50) return;
    const sibling = $el.next();
    if (!sibling.length) return;
    const value = squish(sibling.text());
    if (!value) return;
    push(label, value, selectorFor($, sibling[0]), 'sibling',
      $el.closest(BOILERPLATE_SELECTOR).length > 0);
  });

  // "Label: value" inside a single text block.
  for (const block of blocks) {
    const m = block.text.match(/^([A-Za-z][A-Za-z ./&'-]{1,40}?)\s*[:：]\s*(.{2,300})$/);
    if (m) push(m[1], m[2], block.selector, 'inline', block.boilerplate);
  }

  // Trailing text of a container whose leading child is the label,
  // e.g. <p><strong>Tel</strong> +95 1 234567</p>
  $('p, li, div, span, address').each((_, el) => {
    const $el = $(el);
    const first = $el.children().first();
    if (!first.length) return;
    const tag = (first.prop('tagName') || '').toLowerCase();
    if (!['strong', 'b', 'span', 'label', 'em', 'i'].includes(tag)) return;
    const label = squish(first.text());
    if (!label || label.length > 40) return;
    const full = squish($el.text());
    const rest = squish(full.slice(label.length)).replace(/^[:：\-–—]\s*/, '');
    if (!rest) return;
    push(label, rest, selectorFor($, el), 'prefix',
      $el.closest(BOILERPLATE_SELECTOR).length > 0);
  });

  return pairs;
}

/** Compact, LLM-friendly digest of a page. Keeps provenance out of the prompt. */
export function pageDigest(page, { maxChars = 12000 } = {}) {
  const parts = [];
  if (page.title) parts.push(`TITLE: ${page.title}`);
  if (page.meta['og:title']) parts.push(`OG_TITLE: ${page.meta['og:title']}`);
  if (page.meta['og:description'] || page.meta.description) {
    parts.push(`META_DESCRIPTION: ${page.meta['og:description'] ?? page.meta.description}`);
  }
  const pairLines = page.pairs
    .filter((p) => !p.boilerplate)
    .slice(0, 120)
    .map((p) => `${p.label}: ${truncate(p.value, 200)}`);
  if (pairLines.length) parts.push(`LABELLED VALUES:\n${pairLines.join('\n')}`);
  parts.push(`PAGE TEXT:\n${page.text}`);
  // Plain slice, not `truncate`: the digest's newlines are meaningful.
  const joined = parts.join('\n\n');
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars - 1)}…`;
}
