/**
 * Structured-data extraction: JSON-LD, microdata, Open Graph, meta tags.
 *
 * Schema.org in the wild is irregular: `@graph` wrappers, properties that are
 * sometimes a string and sometimes an object, `@id` references, arrays of one.
 * Rather than model types, we flatten everything into a searchable index of
 * `{key, path, value, entityType}` entries and let the resolvers ask for keys.
 */

import { squish, squishBlock } from '../util/text.js';

/** Schema.org types that describe the page's primary subject. */
const PRIMARY_TYPES = new Set([
  'hotel', 'lodgingbusiness', 'resort', 'motel', 'bedandbreakfast', 'hostel',
  'localbusiness', 'organization', 'corporation', 'restaurant', 'foodestablishment',
  'store', 'place', 'product', 'service', 'event', 'apartment', 'house',
  'accommodation', 'touristattraction', 'realestatelisting', 'medicalbusiness',
  'professionalservice', 'travelagency', 'person', 'article', 'newsarticle',
  'blogposting', 'webpage', 'itempage', 'offer', 'course', 'recipe', 'book',
  'movie', 'softwareapplication', 'jobposting',
]);

/** Types whose properties are noise for page-level extraction. */
const NOISE_TYPES = new Set([
  'breadcrumblist', 'listitem', 'sitenavigationelement', 'wpheader', 'wpfooter',
  'searchaction', 'entrypoint', 'website', 'collectionpage',
]);

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function typeNames(node) {
  const t = node?.['@type'] ?? node?.type;
  return asArray(t)
    .filter((x) => typeof x === 'string')
    .map((x) => x.replace(/^https?:\/\/schema\.org\//i, ''));
}

/** Parse every <script type="application/ld+json"> block, tolerating bad JSON. */
export function parseJsonLd($) {
  const nodes = [];
  $('script[type="application/ld+json"], script[type="application/ld+JSON"]').each((_, el) => {
    const raw = $(el).contents().text() || $(el).text();
    if (!raw || !raw.trim()) return;
    const parsed = tolerantJsonParse(raw);
    for (const item of asArray(parsed)) collectGraph(item, nodes);
  });
  return nodes;
}

function tolerantJsonParse(raw) {
  const text = raw
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    // Common real-world breakage: trailing commas, or several objects concatenated.
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      const objects = [];
      const re = /\{[\s\S]*?\}(?=\s*(?:,|\]|\}|$))/g;
      let m;
      while ((m = re.exec(text))) {
        try {
          objects.push(JSON.parse(m[0]));
        } catch {
          /* skip */
        }
      }
      return objects.length ? objects : null;
    }
  }
}

function collectGraph(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectGraph(n, out);
    return;
  }
  if (node['@graph']) {
    for (const n of asArray(node['@graph'])) collectGraph(n, out);
    const rest = { ...node };
    delete rest['@graph'];
    if (Object.keys(rest).some((k) => !k.startsWith('@'))) out.push(rest);
    return;
  }
  out.push(node);
}

/**
 * Microdata (itemscope/itemprop) — still common on older CMS themes and often
 * the only structured data a hand-built site has.
 */
export function parseMicrodata($) {
  const items = [];
  $('[itemscope]').each((_, el) => {
    const $el = $(el);
    // Only top-level scopes; nested ones are picked up as properties.
    if ($el.parents('[itemscope]').length) return;
    items.push(readScope($, $el));
  });
  return items;
}

function readScope($, $scope) {
  const itemtype = ($scope.attr('itemtype') || '').split(/\s+/).filter(Boolean);
  const obj = { '@type': itemtype.map((t) => t.replace(/^https?:\/\/schema\.org\//i, '')) };
  $scope.find('[itemprop]').each((_, propEl) => {
    const $prop = $(propEl);
    // Skip properties belonging to a deeper scope.
    const owner = $prop.parents('[itemscope]').first();
    if (owner.length && owner[0] !== $scope[0]) return;
    const name = $prop.attr('itemprop');
    if (!name) return;
    const value = $prop.attr('itemscope') !== undefined
      ? readScope($, $prop)
      : microdataValue($, $prop);
    if (value == null || value === '') return;
    if (obj[name] === undefined) obj[name] = value;
    else obj[name] = [...asArray(obj[name]), value];
  });
  return obj;
}

function microdataValue($, $el) {
  const tag = ($el.prop('tagName') || '').toLowerCase();
  const attrByTag = {
    meta: 'content',
    audio: 'src', embed: 'src', iframe: 'src', img: 'src', source: 'src',
    track: 'src', video: 'src',
    a: 'href', area: 'href', link: 'href',
    object: 'data',
    data: 'value',
    time: 'datetime',
  };
  const attr = attrByTag[tag];
  if (attr) {
    const v = $el.attr(attr);
    if (v) return squish(v);
  }
  return squish($el.text());
}

/** All <meta> name/property values plus <link rel> hrefs, in one lowercase map. */
export function parseMeta($) {
  /** @type {Record<string, string>} */
  const meta = {};
  $('meta').each((_, el) => {
    const $el = $(el);
    const name = ($el.attr('property') || $el.attr('name') || $el.attr('itemprop') || '').toLowerCase().trim();
    const content = $el.attr('content');
    if (!name || !content) return;
    if (meta[name] === undefined) meta[name] = squish(content);
  });
  $('link[rel]').each((_, el) => {
    const $el = $(el);
    const rel = ($el.attr('rel') || '').toLowerCase().trim();
    const href = $el.attr('href');
    if (!rel || !href) return;
    const key = `link:${rel}`;
    if (meta[key] === undefined) meta[key] = href.trim();
  });
  return meta;
}

/**
 * Flatten JSON-LD + microdata entities into a searchable index.
 * @returns {{entries: Array<{key: string, path: string, value: string,
 *            entityType: string, primary: boolean, source: string}>,
 *           entities: Array<object>}}
 */
export function buildStructuredIndex({ jsonld = [], microdata = [] } = {}) {
  const entries = [];
  const push = (key, path, value, entityType, primary, source) => {
    const v = typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : squishBlock(value);
    if (!v) return;
    entries.push({
      key: String(key).toLowerCase(),
      path,
      value: v,
      entityType,
      primary,
      source,
    });
  };

  const walk = (node, pathPrefix, source, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, pathPrefix, source, depth);
      return;
    }
    const types = typeNames(node);
    const typeLabel = types[0] || pathPrefix || 'Thing';
    const lowerTypes = types.map((t) => t.toLowerCase());
    const isNoise = lowerTypes.some((t) => NOISE_TYPES.has(t));
    // Schema.org has hundreds of LocalBusiness subtypes (Dentist, Plumber,
    // DaySpa…), so enumerating them is a losing game. A top-level entity that
    // is not known noise is the page's subject; the named list below only adds
    // types that stay primary even when nested.
    const isPrimary =
      (depth === 0 && !isNoise) || lowerTypes.some((t) => PRIMARY_TYPES.has(t));
    const base = pathPrefix ? `${pathPrefix}.${typeLabel}` : typeLabel;

    // Composite values that are far more useful pre-joined than per-field.
    const composite = compositeValue(node, lowerTypes);
    if (composite) {
      for (const [k, v] of Object.entries(composite)) {
        push(k, `${base}.${k}`, v, typeLabel, isPrimary && !isNoise, source);
      }
    }

    for (const [rawKey, rawVal] of Object.entries(node)) {
      if (rawKey.startsWith('@')) continue;
      const key = rawKey;
      for (const val of asArray(rawVal)) {
        if (val == null) continue;
        if (typeof val === 'object') {
          // Objects that are really just a URL wrapper.
          const inner = val.url ?? val.contentUrl ?? val['@id'];
          if (typeof inner === 'string' && Object.keys(val).length <= 3) {
            push(key, `${base}.${key}`, inner, typeLabel, isPrimary && !isNoise, source);
          }
          walk(val, base, source, depth + 1);
        } else if (!isNoise) {
          push(key, `${base}.${key}`, val, typeLabel, isPrimary, source);
        }
      }
    }
  };

  for (const node of jsonld) walk(node, '', 'jsonld', 0);
  for (const node of microdata) walk(node, '', 'microdata', 0);

  return { entries, entities: [...jsonld, ...microdata] };
}

/** Pre-joined values for types whose parts are useless individually. */
function compositeValue(node, lowerTypes) {
  const out = {};

  if (lowerTypes.includes('postaladdress') || node.streetAddress || node.addressLocality) {
    const parts = [
      node.streetAddress,
      node.addressLocality,
      [node.addressRegion, node.postalCode].filter(Boolean).join(' '),
      typeof node.addressCountry === 'object'
        ? node.addressCountry?.name
        : node.addressCountry,
    ]
      .flat()
      .map((p) => squish(p))
      .filter(Boolean);
    if (parts.length) out.address = parts.join(', ');
  }

  if (Array.isArray(node.openingHoursSpecification) || node.openingHoursSpecification) {
    const spec = asArray(node.openingHoursSpecification)
      .map((s) => {
        const days = asArray(s?.dayOfWeek)
          .map((d) => String(d).replace(/^https?:\/\/schema\.org\//i, ''))
          .join(', ');
        const open = s?.opens;
        const close = s?.closes;
        if (!days && !open) return '';
        return `${days}${days ? ': ' : ''}${open ?? '?'}–${close ?? '?'}`;
      })
      .filter(Boolean);
    if (spec.length) out.openinghours = spec.join('; ');
  }
  if (node.openingHours) {
    const oh = asArray(node.openingHours).map((s) => squish(s)).filter(Boolean);
    if (oh.length) out.openinghours = oh.join('; ');
  }

  if (node.geo && typeof node.geo === 'object' && !Array.isArray(node.geo)) {
    if (node.geo.latitude != null) out.latitude = node.geo.latitude;
    if (node.geo.longitude != null) out.longitude = node.geo.longitude;
  }

  // Offers may be nested one or two deep and are where prices actually live.
  const offers = asArray(node.offers).filter((o) => o && typeof o === 'object');
  if (offers.length) {
    const first = offers[0];
    const amount = first.price ?? first.lowPrice ?? first.priceSpecification?.price;
    const currency =
      first.priceCurrency ?? first.priceSpecification?.priceCurrency ?? node.priceCurrency;
    if (amount != null) {
      out.price = currency ? `${currency} ${amount}` : String(amount);
    }
  }

  return Object.keys(out).length ? out : null;
}

/** Convenience: find structured-index entries whose key matches any candidate. */
export function findEntries(index, candidateKeys) {
  const wanted = new Set(candidateKeys.map((k) => k.toLowerCase()));
  return index.entries
    .filter((e) => wanted.has(e.key))
    .sort((a, b) => Number(b.primary) - Number(a.primary));
}
