/**
 * List-record extraction: many records from one page.
 *
 * The single-record cascade answers "what is this page about?". A directory or
 * search-results page asks a different question: "what are the N things listed
 * here?". Running the page-level cascade on such a page returns the site's own
 * og:image and title once — not one row per listing.
 *
 * Two steps:
 *   1. Find the repeating block. No site-specific selectors: group each
 *      element's children by structural signature and keep buckets that repeat.
 *      The winning group is the one whose members actually resolve the
 *      requested labels.
 *   2. Treat each member as its own tiny page (`buildScopeModel`) and run the
 *      normal cascade inside it, plus type-directed fallbacks that are only
 *      safe at this scale (see `RECORD_FALLBACKS`).
 *
 * Why the fallbacks are safe here and not page-wide: "the text in this element
 * that looks like an address" is a reckless guess across a whole page — the
 * footer, a testimonial and a nav blob all compete. Inside one 200-character
 * listing card there is one address, and the type validator is strong evidence.
 */

import { buildScopeModel } from '../core/page.js';
import { resolveField } from './resolvers.js';
import {
  validate, normalizeForOutput, identityKey,
  PHONE_RE, EMAIL_RE, PRICE_RE, HOURS_RE, isSocialProfile,
} from './patterns.js';
import { rankForMain, rankForGallery } from './images.js';
import { squish } from '../util/text.js';

/** Containers that are never a list of records. */
const SKIP_PARENT = new Set(['nav', 'header', 'footer', 'head', 'html', 'select', 'table', 'thead', 'tfoot', 'style', 'script']);

/** Confidence assigned to a type-directed (unlabelled) hit inside a record. */
const FALLBACK_CONFIDENCE = 0.5;

/**
 * Structural fingerprint of an element: tag, digit-stripped class list, and the
 * sequence of its own child tags. Two listing cards match; a card and a nav
 * link do not.
 */
function signature($, el) {
  const $el = $(el);
  const tag = (el.tagName || el.name || '').toLowerCase();
  if (!tag || SKIP_PARENT.has(tag)) return null;
  // Digits are stripped so `item-1`, `item-2` share a signature; ordinal
  // classes are how many CMSs mark repeated rows.
  const cls = ($el.attr('class') || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => c.replace(/\d+/g, '#'))
    .sort()
    .slice(0, 6)
    .join('.');
  const childTags = $el
    .children()
    .toArray()
    .map((c) => (c.tagName || c.name || '').toLowerCase())
    .slice(0, 8)
    .join('>');
  return `${tag}|${cls}|${childTags}`;
}

/**
 * Every plausible repeating group on the page.
 * @returns {Array<{parentSelector: string, signature: string, items: any[], depth: number}>}
 */
export function detectRecordGroups(page, { minItems = 3, minItemText = 15 } = {}) {
  const $ = page.$;
  const groups = [];

  $('*').each((_, parentEl) => {
    const parentTag = (parentEl.tagName || parentEl.name || '').toLowerCase();
    if (SKIP_PARENT.has(parentTag)) return;

    const children = $(parentEl).children().toArray().filter((c) => c.type === 'tag');
    if (children.length < minItems || children.length > 400) return;

    /** @type {Map<string, any[]>} */
    const buckets = new Map();
    for (const child of children) {
      const sig = signature($, child);
      if (!sig) continue;
      if (!buckets.has(sig)) buckets.set(sig, []);
      buckets.get(sig).push(child);
    }

    for (const [sig, items] of buckets) {
      if (items.length < minItems) continue;
      // Rows of icons, spacers or empty columns are not records.
      const withText = items.filter((i) => squish($(i).text()).length >= minItemText);
      if (withText.length < minItems) continue;
      groups.push({
        parentSelector: describe($, parentEl),
        signature: sig,
        items: withText,
        depth: $(parentEl).parents().length,
      });
    }
  });

  return groups;
}

function describe($, el) {
  const $el = $(el);
  const tag = (el.tagName || el.name || 'node').toLowerCase();
  const id = $el.attr('id');
  if (id) return `${tag}#${id}`;
  const cls = ($el.attr('class') || '').split(/\s+/).filter(Boolean).slice(0, 2);
  return cls.length ? `${tag}.${cls.join('.')}` : tag;
}

/**
 * Score a group by how many of the requested labels its members actually yield.
 * Sampling a few members keeps detection cheap on pages with many groups.
 */
function scoreGroup(page, group, specs, { minConfidence, sampleSize = 4 }) {
  const sample = group.items.slice(0, sampleSize);
  let totalFields = 0;
  for (const item of sample) {
    const scope = buildScopeModel(page, item);
    let found = 0;
    for (const spec of specs) {
      const value = resolveInRecord(scope, spec, { minConfidence });
      if (value) found += 1;
    }
    totalFields += found;
  }
  return { avgFields: totalFields / sample.length, count: group.items.length };
}

/**
 * Pick the repeating group that best answers the requested labels.
 *
 * Tie-breaking matters: a grid often nests (rows of three cards), so both the
 * row group and the card group resolve every field. More items at the same
 * field yield means the finer grouping, which is the one that gives one record
 * per listing rather than one record per row.
 */
export function chooseRecordGroup(page, specs, { minConfidence = 0.4, minFieldsPerRecord = 2 } = {}) {
  const groups = detectRecordGroups(page);
  if (!groups.length) return null;

  const required = Math.min(minFieldsPerRecord, specs.length);
  const scored = [];
  for (const group of groups) {
    const { avgFields, count } = scoreGroup(page, group, specs, { minConfidence });
    if (avgFields < required) continue;
    scored.push({ ...group, avgFields, count });
  }
  if (!scored.length) return null;

  scored.sort(
    (a, b) =>
      // Half-field buckets, so a marginally better yield does not outrank a
      // much finer grouping.
      Math.round(b.avgFields * 2) - Math.round(a.avgFields * 2) ||
      b.count - a.count ||
      b.depth - a.depth,
  );
  return scored[0];
}

/**
 * Resolve one label inside one record scope.
 * @returns {{value: any, confidence: number, method: string, selector: string|null}|null}
 */
export function resolveInRecord(scope, spec, { minConfidence = 0.4 } = {}) {
  // 1. The normal cascade. Inside a scope this is mostly tier 3-4: `tel:`
  //    links, `<dt>/<dd>` pairs, itemprop, class-name hints.
  const candidates = resolveField(scope, spec).filter((c) => c.confidence >= minConfidence);

  if (spec.plural) {
    const values = dedupe(spec, candidates.map((c) => c.value));
    if (values.length) {
      return { value: values, confidence: candidates[0].confidence, method: candidates[0].method, selector: candidates[0].selector };
    }
  } else if (candidates.length) {
    const best = candidates[0];
    return { value: best.value, confidence: best.confidence, method: best.method, selector: best.selector };
  }

  // 2. Type-directed fallback, safe only because the scope is one record.
  const fallback = RECORD_FALLBACKS[spec.type];
  if (!fallback) return null;
  const found = fallback(scope, spec);
  if (!found) return null;

  const raw = Array.isArray(found.value) ? found.value : [found.value];
  const clean = [];
  for (const v of raw) {
    const normalized = normalizeForOutput(spec.type, v);
    if (normalized && validate(spec.type, normalized, { context: scope.text })) clean.push(normalized);
  }
  if (!clean.length) return null;

  return {
    value: spec.plural ? dedupe(spec, clean) : clean[0],
    confidence: FALLBACK_CONFIDENCE,
    method: `record scope: ${found.method}`,
    selector: found.selector ?? null,
  };
}

function dedupe(spec, values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const id = identityKey(spec.type, v);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(v);
  }
  return out;
}

/* ------------------------------------------------- type-directed fallbacks */

/**
 * "The thing in this element that looks like an X." Each returns raw values;
 * `resolveInRecord` validates them.
 *
 * @type {Record<string, (scope: object, spec: object) => {value: any, method: string, selector?: string}|null>}
 */
const RECORD_FALLBACKS = {
  name: (scope) => {
    // A listing's name is its heading, else its link text, else its most
    // prominent short line.
    const heading = scope.$('h1,h2,h3,h4,h5,h6').first();
    if (heading.length && squish(heading.text())) {
      return { value: squish(heading.text()), method: 'first heading', selector: (heading.prop('tagName') || '').toLowerCase() };
    }
    const link = scope.links.find((l) => l.text && l.text.length >= 2 && l.text.length <= 120);
    if (link) return { value: link.text, method: 'first link text', selector: 'a' };
    const candidate = scope.blocks
      .filter((b) => b.text.length >= 2 && b.text.length <= 120 && !b.boilerplate)
      .sort((a, b) => a.depth - b.depth || b.text.length - a.text.length)[0];
    return candidate ? { value: candidate.text, method: 'most prominent text', selector: candidate.selector } : null;
  },

  text: (scope, spec) => {
    // Only answer an unlabelled text field from a value that is clearly a
    // value, never from arbitrary prose.
    const pair = scope.pairs.find((p) => spec.keywords.some((k) => k.length >= 3 && p.label.toLowerCase().includes(k)));
    return pair ? { value: pair.value, method: `label "${pair.label}"`, selector: pair.selector } : null;
  },

  phone: (scope) => {
    const tel = scope.$('a[href^="tel:"], a[href^="callto:"]').first();
    if (tel.length) {
      const href = (tel.attr('href') || '').replace(/^(tel|callto):/i, '').split('?')[0];
      return { value: href || squish(tel.text()), method: 'tel: link', selector: 'a[href^=tel:]' };
    }
    const matches = [...scope.text.matchAll(PHONE_RE)].map((m) => squish(m[0]));
    return matches.length ? { value: matches, method: 'phone pattern in record text' } : null;
  },

  email: (scope) => {
    const mail = scope.$('a[href^="mailto:"]').first();
    if (mail.length) {
      return { value: (mail.attr('href') || '').replace(/^mailto:/i, '').split('?')[0], method: 'mailto: link', selector: 'a[href^=mailto:]' };
    }
    const matches = [...scope.text.matchAll(EMAIL_RE)].map((m) => m[0]);
    return matches.length ? { value: matches, method: 'email pattern in record text' } : null;
  },

  address: (scope) => {
    // The longest block that passes address validation. Longest, because an
    // address split across lines is often re-joined into one block by the
    // block collector, and the fuller form is the better answer.
    const blocks = scope.blocks
      .filter((b) => validate('address', b.text))
      .sort((a, b) => b.text.length - a.text.length);
    if (blocks.length) return { value: blocks[0].text, method: 'text matching an address shape', selector: blocks[0].selector };
    return validate('address', scope.text) ? { value: scope.text, method: 'record text as address' } : null;
  },

  price: (scope) => {
    const matches = [...scope.text.matchAll(PRICE_RE)].map((m) => squish(m[0]));
    return matches.length ? { value: matches, method: 'price pattern in record text' } : null;
  },

  hours: (scope) => {
    const matches = [...scope.text.matchAll(HOURS_RE)].map((m) => squish(m[0]));
    return matches.length ? { value: matches.join('; '), method: 'opening-hours pattern in record text' } : null;
  },

  url: (scope) => {
    const link = scope.links[0];
    return link ? { value: link.url, method: 'first link in record', selector: 'a[href]' } : null;
  },

  social: (scope, spec) => {
    if (!spec.social) return null;
    const link = scope.links.find((l) => isSocialProfile(l.url, spec.social));
    return link ? { value: link.url, method: `${spec.social} profile link`, selector: 'a[href]' } : null;
  },

  image: (scope) => {
    // Inside one record, relax the logo filter: a listing's only picture is
    // its picture, even when the markup calls it a logo.
    const ranked = rankForMain(scope.images);
    if (ranked.length) return { value: ranked[0].url, method: `image ${ranked[0].channel}`, selector: ranked[0].selector };
    if (scope.images.length) {
      return { value: scope.images[0].url, method: `only image in record (${scope.images[0].channel})`, selector: scope.images[0].selector };
    }
    return null;
  },

  image_list: (scope) => {
    const ranked = rankForGallery(scope.images);
    const pool = ranked.length ? ranked : scope.images;
    return pool.length ? { value: pool.map((i) => i.url), method: 'images in record' } : null;
  },

  list: (scope, spec) => {
    const pair = scope.pairs.find((p) => spec.keywords.some((k) => k.length >= 3 && p.label.toLowerCase().includes(k)));
    if (pair) return { value: pair.value, method: `label "${pair.label}"`, selector: pair.selector };
    return null;
  },
};

/**
 * Extract every record on the page.
 *
 * @param {import('../core/page.js').PageModel} page
 * @param {import('./labels.js').FieldSpec[]} specs
 * @param {object} [options]
 * @returns {{records: Array<object>, group: object|null, warnings: string[]}}
 */
export function extractRecords(page, specs, options = {}) {
  const { minConfidence = 0.4, maxRecords = 200, minFieldsPerRecord = 2 } = options;
  const warnings = [];

  const group = chooseRecordGroup(page, specs, { minConfidence, minFieldsPerRecord });
  if (!group) {
    return { records: [], group: null, warnings };
  }

  const records = [];
  const seen = new Set();

  for (const [index, item] of group.items.slice(0, maxRecords).entries()) {
    const scope = buildScopeModel(page, item);
    /** @type {Record<string, any>} */
    const data = {};
    /** @type {Record<string, any>} */
    const fields = {};
    let found = 0;

    for (const spec of specs) {
      const hit = resolveInRecord(scope, spec, { minConfidence });
      if (hit) found += 1;
      data[spec.key] = hit ? hit.value : spec.plural ? [] : null;
      fields[spec.key] = {
        label: spec.label,
        value: data[spec.key],
        source_url: page.finalUrl,
        method: hit?.method ?? null,
        selector: hit?.selector ?? null,
        confidence: hit ? Math.round(hit.confidence * 100) / 100 : 0,
        value_type: spec.type,
        found: Boolean(hit),
      };
    }

    // A member of the repeating group that yielded nothing is a spacer or an
    // advert slot, not a record.
    if (!found) continue;

    // Identical rows are a rendering artefact (e.g. a duplicated card).
    const identity = specs.map((s) => JSON.stringify(data[s.key])).join('|');
    if (seen.has(identity)) continue;
    seen.add(identity);

    records.push({ index, data, fields, source_url: page.finalUrl, fields_found: found });
  }

  if (group.items.length > maxRecords) {
    warnings.push(`Page has ${group.items.length} list items; kept the first ${maxRecords} (maxRecords).`);
  }

  return { records, group, warnings };
}
