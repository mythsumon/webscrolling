/**
 * The tier 1-4 resolution cascade.
 *
 * Every resolver returns *candidates*, never answers:
 *   { value, confidence, method, selector, sourceUrl }
 *
 * `resolveField` collects candidates from all applicable tiers, validates each
 * against the field's type, and returns them sorted. The pipeline decides what
 * to keep. Keeping candidates (rather than short-circuiting on the first hit)
 * costs almost nothing and lets a later page beat an earlier weak match.
 */

import {
  validate, normalizeForOutput, identityKey,
  PHONE_RE, EMAIL_RE, PRICE_RE, HOURS_RE,
  isSocialProfile, extractGeoFromUrl,
} from './patterns.js';
import { rankForMain, rankForGallery } from './images.js';
import { squish, tokens, tokenOverlap, similarity } from '../util/text.js';
import { absolutize } from '../util/url.js';

/**
 * Schema.org keys that appear on almost every entity, so a match on them says
 * nothing about *which* entity answered. See the `schemaEntityTypes` gate.
 */
const GENERIC_SCHEMA_KEYS = new Set(['name', 'url', 'description', 'image', 'title', 'headline', 'identifier']);

/** Tier base confidences. See ARCHITECTURE.md §2. */
const TIER = {
  jsonldPrimary: 0.95,
  jsonld: 0.88,
  microdata: 0.86,
  meta: 0.85,
  semantic: 0.8,
  pair: 0.7,
  attribute: 0.62,
  proximity: 0.52,
  regex: 0.45,
};

/**
 * @param {import('../core/page.js').PageModel} page
 * @param {import('./labels.js').FieldSpec} spec
 * @returns {Array<{value: string, confidence: number, method: string, selector: string|null, sourceUrl: string}>}
 */
export function resolveField(page, spec) {
  const raw = [];
  const collect = (arr) => {
    for (const c of arr ?? []) if (c && c.value != null) raw.push(c);
  };

  // Image labels are served exclusively by the harvester. It already ingests
  // JSON-LD images and og:image as channels of its own, with junk filtering,
  // quality ranking and identity dedupe — running tiers 1-2 separately would
  // reintroduce the raw, undeduped URLs above the ranked ones.
  if (spec.type === 'image' || spec.type === 'image_list') {
    return finalise(fromImages(page, spec), page, spec);
  }

  // Tier 1-2 apply to every other type.
  collect(fromStructured(page, spec));
  collect(fromMeta(page, spec));

  // Tier 3-4 are type-specific.
  switch (spec.type) {
    case 'phone':
      collect(fromTelLinks(page, spec));
      collect(fromPairs(page, spec));
      collect(fromRegex(page, spec, PHONE_RE));
      break;
    case 'email':
      collect(fromMailtoLinks(page, spec));
      collect(fromPairs(page, spec));
      collect(fromRegex(page, spec, EMAIL_RE));
      break;
    case 'social':
      collect(fromSocialLinks(page, spec));
      break;
    case 'url':
      collect(fromPairs(page, spec));
      collect(fromCanonical(page, spec));
      break;
    case 'address':
      collect(fromAddressElements(page, spec));
      collect(fromPairs(page, spec));
      collect(fromProximity(page, spec));
      break;
    case 'latitude':
    case 'longitude':
      collect(fromGeo(page, spec));
      collect(fromPairs(page, spec));
      break;
    case 'hours':
      collect(fromPairs(page, spec));
      collect(fromProximity(page, spec));
      collect(fromRegex(page, spec, HOURS_RE, { join: true }));
      break;
    case 'price':
      collect(fromPairs(page, spec));
      collect(fromAttributes(page, spec));
      collect(fromRegex(page, spec, PRICE_RE));
      break;
    case 'name':
      // h1 and <title> name the page's subject. For a label about someone
      // *within* the page ("CEO Name", "Head Chef") that is the wrong answer,
      // so those specs skip headings and rely on labelled values instead.
      if (!spec.schemaEntityTypes?.length) collect(fromHeadings(page, spec));
      collect(fromPairs(page, spec));
      collect(fromAttributes(page, spec));
      break;
    case 'description':
      collect(fromDescriptionBlocks(page, spec));
      collect(fromPairs(page, spec));
      break;
    case 'list':
      collect(fromListElements(page, spec));
      collect(fromPairs(page, spec));
      break;
    default:
      collect(fromPairs(page, spec));
      collect(fromAttributes(page, spec));
      collect(fromProximity(page, spec));
      break;
  }

  return finalise(raw, page, spec);
}

/* ------------------------------------------------------------- validation */

function finalise(candidates, page, spec) {
  /** @type {Map<string, object>} */
  const byIdentity = new Map();

  for (const c of candidates) {
    const value = normalizeForOutput(spec.type, c.value);
    if (!value) continue;
    if (!validate(spec.type, value, { context: c.context ?? c.method ?? '' })) continue;

    let confidence = c.confidence;

    // Chrome text is a weaker signal for page-specific values, but for a
    // phone/email/social the footer is a perfectly normal home.
    if (c.boilerplate && !['phone', 'email', 'social', 'address', 'hours'].includes(spec.type)) {
      confidence -= 0.15;
    }
    if (c.boilerplate) confidence -= 0.03;
    confidence = Math.max(0, Math.min(0.99, confidence));

    const id = identityKey(spec.type, value);
    const existing = byIdentity.get(id);
    if (!existing || confidence > existing.confidence) {
      byIdentity.set(id, {
        value,
        raw: squish(c.value),
        confidence,
        method: c.method,
        selector: c.selector ?? null,
        sourceUrl: page.finalUrl,
        order: c.order ?? 999,
      });
    }
  }

  return [...byIdentity.values()].sort(
    (a, b) => b.confidence - a.confidence || a.order - b.order,
  );
}

/* --------------------------------------------------- tier 1: structured data */

function fromStructured(page, spec) {
  const out = [];
  const narrowTerms = narrowTermsFor(spec);
  const wanted = new Set(spec.schemaKeys.map((k) => k.toLowerCase()));
  // Type-driven extras: a "Room Type" query should also read `name` on
  // nested HotelRoom entities, which the label alone would not suggest.
  for (const extra of typeSchemaKeys(spec)) wanted.add(extra);

  // `sameAs` holds every network's profile, so a generic key match would let an
  // Instagram label answer with the Facebook URL. Social specs are served
  // exclusively by the network-filtered block at the end of this function.
  const entries = spec.type === 'social' ? [] : page.structuredIndex.entries;

  for (const entry of entries) {
    // A label naming a distinct channel ("Fax", "WhatsApp") must not be
    // answered by the generic `telephone` property.
    if (narrowTerms.length && !narrowTerms.some((t) => `${entry.key} ${entry.path}`.toLowerCase().includes(t))) {
      continue;
    }

    // A spec that wants a particular entity type ("CEO Name" wants a Person)
    // may only read generic keys off an entity of that type — otherwise
    // `name` on the business entity answers a question about a person.
    if (
      spec.schemaEntityTypes?.length &&
      GENERIC_SCHEMA_KEYS.has(entry.key) &&
      !spec.schemaEntityTypes.includes(entry.entityType.toLowerCase())
    ) {
      continue;
    }

    let score = 0;
    if (wanted.has(entry.key)) {
      score = entry.primary ? TIER.jsonldPrimary : TIER.jsonld;
    } else {
      // Fuzzy key match for bespoke schemas ("hotelPhone", "contact_number").
      const sim = Math.max(
        ...spec.schemaKeys.map((k) => similarity(k, entry.key)),
        tokenOverlap(spec.keywords, tokens(entry.key)),
      );
      if (sim >= 0.7) score = TIER.jsonld * 0.85;
      else continue;
    }
    if (entry.source === 'microdata') score = Math.min(score, TIER.microdata);

    // A nested non-primary entity's `name` is a weak answer for a page name.
    if (entry.key === 'name' && !entry.primary && spec.type === 'name') score -= 0.2;

    out.push({
      value: entry.value,
      confidence: score,
      method: `${entry.source}:${entry.path}`,
      selector: null,
      context: entry.path,
      order: 0,
    });
  }

  // Social profiles hide inside sameAs arrays.
  if (spec.type === 'social' && spec.social) {
    for (const entry of page.structuredIndex.entries) {
      if (entry.key !== 'sameas' && entry.key !== 'url') continue;
      if (!isSocialProfile(entry.value, spec.social)) continue;
      out.push({
        value: entry.value,
        confidence: TIER.jsonldPrimary,
        method: `${entry.source}:${entry.path}`,
        order: 0,
      });
    }
  }

  return out;
}

function typeSchemaKeys(spec) {
  switch (spec.type) {
    case 'address': return ['address', 'streetaddress'];
    case 'phone': return ['telephone', 'phone'];
    case 'email': return ['email'];
    case 'price': return ['price', 'lowprice', 'pricerange'];
    case 'latitude': return ['latitude'];
    case 'longitude': return ['longitude'];
    case 'hours': return ['openinghours', 'openinghoursspecification'];
    case 'rating': return ['ratingvalue', 'starrating'];
    case 'description': return ['description'];
    case 'name': return ['name', 'legalname', 'headline'];
    case 'image':
    case 'image_list': return ['image', 'contenturl', 'thumbnailurl', 'logo'];
    default: return [];
  }
}

/* ------------------------------------------------------ tier 2: meta / OG */

function fromMeta(page, spec) {
  const out = [];
  const keys = [...spec.metaKeys];

  // Generic meta lookup by keyword, for labels with no ontology metaKeys.
  for (const metaKey of Object.keys(page.meta)) {
    if (keys.includes(metaKey)) continue;
    const keyTokens = tokens(metaKey.replace(/^(og|twitter|al|fb|article|product|place):/, ''));
    if (!keyTokens.length) continue;
    if (tokenOverlap(keyTokens, spec.keywords) >= 0.8) keys.push(metaKey);
  }

  for (const key of keys) {
    const value = page.meta[key];
    if (!value) continue;
    let v = value;
    if (spec.type === 'image' || spec.type === 'image_list' || spec.type === 'url' || spec.type === 'social') {
      v = absolutize(value, page.finalUrl) ?? value;
    }
    if (spec.type === 'social' && spec.social && !isSocialProfile(v, spec.social)) {
      // twitter:site is a handle, not a URL — build the profile URL from it.
      if (spec.social === 'twitter' && /^@?[A-Za-z0-9_]{1,15}$/.test(value)) {
        v = `https://twitter.com/${value.replace(/^@/, '')}`;
      } else {
        continue;
      }
    }
    out.push({
      value: v,
      confidence: key.startsWith('og:') || key.startsWith('twitter:') ? TIER.meta : TIER.meta - 0.08,
      method: `meta:${key}`,
      context: key,
      order: 1,
    });
  }

  // `geo.position` / `ICBM` hold "lat;lng" and "lat, lng".
  if (spec.type === 'latitude' || spec.type === 'longitude') {
    for (const key of ['geo.position', 'icbm', 'place:location:latitude', 'place:location:longitude']) {
      const raw = page.meta[key];
      if (!raw) continue;
      const parts = raw.split(/[;,]/).map((s) => squish(s));
      if (key.endsWith('latitude')) {
        if (spec.type === 'latitude') out.push({ value: parts[0], confidence: TIER.meta, method: `meta:${key}`, order: 1 });
        continue;
      }
      if (key.endsWith('longitude')) {
        if (spec.type === 'longitude') out.push({ value: parts[0], confidence: TIER.meta, method: `meta:${key}`, order: 1 });
        continue;
      }
      if (parts.length >= 2) {
        out.push({
          value: spec.type === 'latitude' ? parts[0] : parts[1],
          confidence: TIER.meta,
          method: `meta:${key}`,
          order: 1,
        });
      }
    }
  }

  return out;
}

function fromCanonical(page, spec) {
  const out = [];
  const canonical = page.meta['link:canonical'] ?? page.meta['og:url'];
  // Only answer a "Website" label with the page's own URL — never a random link.
  if (canonical && spec.keywords.some((k) => ['website', 'url', 'homepage', 'site', 'web', 'link'].includes(k))) {
    const abs = absolutize(canonical, page.finalUrl);
    if (abs) {
      try {
        out.push({
          value: new URL(abs).origin + '/',
          confidence: TIER.semantic,
          method: 'link:canonical (site origin)',
          order: 2,
        });
      } catch { /* ignore */ }
    }
  }
  return out;
}

/* ------------------------------------------------- tier 3: semantic HTML */

function fromTelLinks(page, spec) {
  const out = [];
  page.$('a[href^="tel:"], a[href^="TEL:"], a[href^="callto:"], a[href^="sms:"]').each((_, el) => {
    const $el = page.$(el);
    const href = $el.attr('href') || '';
    const hrefValue = href.replace(/^(tel|callto|sms):/i, '').split('?')[0];
    const text = squish($el.text());
    // The printed number is the better answer when it is a valid phone: hrefs
    // are frequently stripped to bare digits, losing the national grouping.
    const value = text && validate('phone', text, { context: 'phone' }) ? text : hrefValue;
    const context = `${$el.attr('class') || ''} ${$el.attr('aria-label') || ''} ${text} ${parentContext(page.$, el)}`;
    // WhatsApp/fax labels must not collect the main phone and vice versa.
    if (!contextMatchesSpec(context, spec, { requireForNarrow: true })) return;
    out.push({
      value: value || text,
      confidence: TIER.semantic,
      method: 'a[href^=tel:]',
      selector: selectorOf(page.$, el),
      context,
      boilerplate: page.$(el).closest('footer, nav, header').length > 0,
      order: 3,
    });
  });

  // wa.me links carry the WhatsApp number in the path.
  if (spec.social === 'whatsapp' || spec.keywords.includes('whatsapp')) {
    page.$('a[href*="wa.me"], a[href*="api.whatsapp.com"]').each((_, el) => {
      const href = page.$(el).attr('href') || '';
      const m = href.match(/(?:wa\.me\/|phone=)(\+?\d[\d\s-]{6,})/);
      if (m) {
        out.push({
          value: m[1],
          confidence: TIER.semantic,
          method: 'a[href*=wa.me]',
          selector: selectorOf(page.$, el),
          order: 3,
        });
      }
    });
  }

  return out;
}

function fromMailtoLinks(page, spec) {
  const out = [];
  page.$('a[href^="mailto:"], a[href^="MAILTO:"]').each((_, el) => {
    const $el = page.$(el);
    const value = ($el.attr('href') || '').replace(/^mailto:/i, '').split('?')[0];
    const context = `${$el.attr('class') || ''} ${squish($el.text())} ${parentContext(page.$, el)}`;
    if (!contextMatchesSpec(context, spec, { requireForNarrow: true })) return;
    out.push({
      value,
      confidence: TIER.semantic,
      method: 'a[href^=mailto:]',
      selector: selectorOf(page.$, el),
      context,
      boilerplate: $el.closest('footer, nav, header').length > 0,
      order: 3,
    });
  });
  return out;
}

function fromSocialLinks(page, spec) {
  const out = [];
  if (!spec.social) return out;
  for (const link of page.links) {
    if (!isSocialProfile(link.url, spec.social)) continue;
    out.push({
      value: link.url,
      confidence: TIER.semantic,
      method: `a[href] (${spec.social} profile)`,
      selector: link.className ? `a.${link.className.split(/\s+/)[0]}` : 'a[href]',
      order: 3,
    });
  }
  return out;
}

function fromAddressElements(page, spec) {
  const out = [];
  page.$('address, [itemprop="address"], [itemtype*="PostalAddress"], .adr, .address, [class*="address"]').each((_, el) => {
    const $el = page.$(el);
    if ($el.find('address, [itemprop="address"]').length) return; // prefer the inner one
    const value = squish($el.text());
    if (!value) return;
    const isSemantic = ($el.prop('tagName') || '').toLowerCase() === 'address' || $el.attr('itemprop') === 'address';
    out.push({
      value,
      confidence: isSemantic ? TIER.semantic : TIER.attribute,
      method: isSemantic ? '<address>' : '[class*=address]',
      selector: selectorOf(page.$, el),
      boilerplate: $el.closest('footer, nav, header').length > 0,
      order: 3,
    });
  });

  // Google Maps embeds usually carry the address in the iframe title or query.
  page.$('iframe[src*="google.com/maps"], iframe[src*="maps.google"]').each((_, el) => {
    const title = squish(page.$(el).attr('title') || '');
    if (title && title.length > 10) {
      out.push({
        value: title,
        confidence: TIER.attribute,
        method: 'iframe[maps] title',
        selector: 'iframe',
        order: 4,
      });
    }
  });

  return out;
}

function fromGeo(page, spec) {
  const out = [];
  const want = spec.type === 'latitude' ? 'latitude' : 'longitude';

  // Map embeds, static-map images and "directions" links carry coordinates.
  const urls = [];
  page.$('iframe[src], a[href*="maps"], img[src*="maps"], [data-lat], [data-lng], [data-latitude], [data-longitude]').each((_, el) => {
    const $el = page.$(el);
    const dataLat = $el.attr('data-lat') ?? $el.attr('data-latitude');
    const dataLng = $el.attr('data-lng') ?? $el.attr('data-longitude');
    if (dataLat && want === 'latitude') {
      out.push({ value: dataLat, confidence: TIER.attribute + 0.1, method: 'data-lat attribute', selector: selectorOf(page.$, el), order: 3 });
    }
    if (dataLng && want === 'longitude') {
      out.push({ value: dataLng, confidence: TIER.attribute + 0.1, method: 'data-lng attribute', selector: selectorOf(page.$, el), order: 3 });
    }
    const src = $el.attr('src') || $el.attr('href');
    if (src && /maps|geo:|openstreetmap/i.test(src)) urls.push({ src, el });
  });

  for (const { src, el } of urls) {
    const geo = extractGeoFromUrl(src);
    if (!geo) continue;
    out.push({
      value: geo[want],
      confidence: TIER.attribute,
      method: 'coordinates parsed from map URL',
      selector: selectorOf(page.$, el),
      order: 4,
    });
  }

  // Inline scripts that initialise a map: {lat: 21.95, lng: 96.08}
  const scriptText = page.$('script:not([src])').text();
  const inline = scriptText.match(/["']?lat(?:itude)?["']?\s*[:=]\s*["']?(-?\d{1,3}\.\d{3,})["']?[\s\S]{0,80}?["']?(?:lng|lon|longitude)["']?\s*[:=]\s*["']?(-?\d{1,3}\.\d{3,})/i);
  if (inline) {
    out.push({
      value: want === 'latitude' ? inline[1] : inline[2],
      confidence: TIER.proximity + 0.1,
      method: 'inline script map init',
      order: 5,
    });
  }

  return out;
}

/* ---------------------------------------------- tier 4: label proximity */

function fromPairs(page, spec) {
  const out = [];
  for (const pair of page.pairs) {
    const score = labelMatchScore(pair.label, spec);
    if (score <= 0) continue;
    // "Phone" must not take the row labelled "Fax", even though the ontology
    // treats them as related.
    if (!contextMatchesSpec(pair.label, spec, { requireForNarrow: true })) continue;
    const values = spec.plural ? splitList(pair.value) : [pair.value];
    for (const value of values) {
      out.push({
        value,
        confidence: TIER.pair * score,
        method: `label pair (${pair.kind}): "${pair.label}"`,
        selector: pair.selector,
        context: pair.label,
        boilerplate: pair.boilerplate,
        order: 6,
      });
    }
  }
  return out;
}

function fromAttributes(page, spec) {
  const out = [];
  if (!spec.attrHints.length) return out;

  for (const block of page.blocks) {
    const attrText = `${block.className} ${block.id} ${block.itemprop}`.toLowerCase();
    if (!attrText.trim()) continue;
    const hit = spec.attrHints.find((h) => h.length >= 3 && attrText.includes(h));
    if (!hit) continue;
    // A container's whole text is rarely the value; prefer leaf-ish blocks.
    const value = block.text;
    if (!value || value.length > 300) continue;
    out.push({
      value,
      confidence: TIER.attribute * (block.itemprop ? 1.15 : 1),
      method: `attribute match [${block.itemprop ? 'itemprop' : 'class/id'}*="${hit}"]`,
      selector: block.selector,
      context: attrText,
      boilerplate: block.boilerplate,
      order: 7,
    });
  }
  return out;
}

/**
 * Text that follows a heading or label-like block whose words match the spec.
 * This is what finds "Contact" -> the phone number two elements later.
 */
function fromProximity(page, spec) {
  const out = [];
  const blocks = page.blocks;

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.text.length > 60) continue;
    const score = labelMatchScore(block.text, spec);
    if (score <= 0) continue;

    // Look at the next few blocks for the first value that validates.
    for (let j = i + 1; j < Math.min(i + 5, blocks.length); j += 1) {
      const next = blocks[j];
      if (!next.text || next.text.length > 500) continue;
      if (labelMatchScore(next.text, spec) > 0 && next.text.length < 30) continue; // another label
      out.push({
        value: next.text,
        confidence: TIER.proximity * score * (1 - (j - i - 1) * 0.12),
        method: `text after "${block.text}"`,
        selector: next.selector,
        context: block.text,
        boilerplate: next.boilerplate,
        order: 8 + (j - i),
      });
    }
  }
  return out;
}

function fromHeadings(page, spec) {
  const out = [];
  // For a name/title, h1 and the document title are strong signals.
  const h1 = squish(page.$('h1').first().text());
  if (h1) {
    out.push({ value: h1, confidence: TIER.semantic - 0.05, method: 'h1', selector: 'h1', order: 3 });
  }
  if (page.title) {
    // Strip the " | Site Name" suffix sites append.
    const stripped = page.title.split(/\s+[|–—-]\s+/)[0];
    out.push({ value: stripped, confidence: TIER.pair, method: '<title>', selector: 'title', order: 5 });
    out.push({ value: page.title, confidence: TIER.pair - 0.1, method: '<title> (full)', selector: 'title', order: 6 });
  }
  const siteName = page.$('.site-title, .logo, [class*="brand"]').first();
  if (siteName.length) {
    const v = squish(siteName.text());
    if (v) out.push({ value: v, confidence: TIER.attribute, method: 'site title element', selector: selectorOf(page.$, siteName[0]), order: 7 });
  }
  return out;
}

function fromDescriptionBlocks(page, spec) {
  const out = [];
  // Longest paragraph inside a container whose attributes match the label,
  // else the longest paragraph in the main content area.
  const scored = [];
  page.$('p').each((_, el) => {
    const $el = page.$(el);
    const text = squish($el.text());
    if (text.length < 40) return;
    if ($el.closest('footer, nav, header, aside').length) return;
    const attrText = [
      $el.attr('class'), $el.attr('id'),
      $el.parent().attr('class'), $el.parent().attr('id'),
      $el.closest('section[id], div[id]').first().attr('id'),
    ].filter(Boolean).join(' ').toLowerCase();
    const heading = squish($el.closest('section, article, div').first().find('h1,h2,h3').first().text());
    const attrBoost = spec.attrHints.some((h) => h.length >= 4 && attrText.includes(h)) ? 0.12 : 0;
    const headingBoost = labelMatchScore(heading, spec) > 0 ? 0.1 : 0;
    scored.push({
      text,
      score: Math.min(0.72, 0.4 + Math.min(0.15, text.length / 4000) + attrBoost + headingBoost),
      selector: selectorOf(page.$, el),
      length: text.length,
    });
  });

  scored.sort((a, b) => b.score - a.score || b.length - a.length);
  for (const s of scored.slice(0, 4)) {
    out.push({ value: s.text, confidence: s.score, method: 'longest matching <p>', selector: s.selector, order: 7 });
  }
  return out;
}

function fromListElements(page, spec) {
  const out = [];
  // Lists whose heading or container attributes match the label.
  page.$('ul, ol').each((_, el) => {
    const $el = page.$(el);
    if ($el.closest('nav, footer, header, [role="navigation"]').length) return;
    const items = $el
      .children('li')
      .map((__, li) => squish(page.$(li).text()))
      .get()
      .filter((t) => t && t.length <= 200);
    if (items.length < 2) return;

    const attrText = [$el.attr('class'), $el.attr('id'), $el.parent().attr('class')]
      .filter(Boolean).join(' ').toLowerCase();
    const heading = squish(
      $el.prevAll('h1,h2,h3,h4,h5,h6').first().text() ||
      $el.parent().prevAll('h1,h2,h3,h4,h5,h6').first().text() ||
      $el.closest('section, div').first().find('h1,h2,h3,h4').first().text(),
    );

    const attrScore = spec.attrHints.some((h) => h.length >= 4 && attrText.includes(h)) ? 0.9 : 0;
    const headScore = labelMatchScore(heading, spec);
    // Keyword hits inside the items themselves ("Free WiFi", "Swimming Pool").
    const itemScore = tokenOverlap(
      spec.keywords.filter((k) => k.length > 3),
      tokens(items.join(' ')),
    );
    const score = Math.max(attrScore, headScore, itemScore >= 0.25 ? 0.6 : 0);
    if (score <= 0) return;

    for (const item of items) {
      out.push({
        value: item,
        confidence: TIER.pair * score,
        method: heading ? `list under "${heading}"` : 'list matching label',
        selector: selectorOf(page.$, el),
        context: `${heading} ${attrText}`,
        boilerplate: false,
        order: 6,
      });
    }
  });

  // Amenity-style chips are often divs/spans, not <li>.
  if (!out.length) {
    for (const hint of spec.attrHints.filter((h) => h.length >= 5)) {
      page.$(`[class*="${hint}"]`).each((_, el) => {
        const $el = page.$(el);
        const children = $el.children();
        if (children.length < 2 || children.length > 60) return;
        children.each((__, child) => {
          const t = squish(page.$(child).text());
          if (t && t.length <= 60) {
            out.push({
              value: t,
              confidence: TIER.attribute,
              method: `chips in [class*="${hint}"]`,
              selector: selectorOf(page.$, child),
              order: 7,
            });
          }
        });
      });
      if (out.length) break;
    }
  }

  return out;
}

/* ------------------------------------------------------------- images */

function fromImages(page, spec) {
  const out = [];
  if (!page.images.length) return out;

  const labelTokens = tokens(spec.label);
  const wantsLogo = labelTokens.includes('logo');

  // Narrowing words must come from the label itself. `spec.keywords` also
  // carries the ontology's DOM hints (hero, banner, slider, lightbox…), which
  // are there to *find* images, not to filter them — using them here would
  // make "Gallery Images" match only elements literally classed "lightbox".
  const GENERIC_IMAGE_WORDS = new Set([
    'image', 'images', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pics',
    'gallery', 'galleries', 'media', 'main', 'primary', 'all', 'url', 'urls', 'link', 'links',
  ]);
  const narrowing = labelTokens.filter((k) => k.length > 2 && !GENERIC_IMAGE_WORDS.has(k));

  // "Menu Image" / "Room Photos": restrict to images whose context mentions the
  // narrowing words. Falls back to the full pool when nothing matches, so a
  // narrow label never returns null just because the site lacks alt text.
  let pool = page.images;
  if (narrowing.length) {
    const matched = page.images.filter((img) =>
      narrowing.some((k) => (img.context || '').includes(k) || (img.alt || '').toLowerCase().includes(k) || img.url.toLowerCase().includes(k)),
    );
    if (matched.length) pool = matched;
  }
  if (wantsLogo) {
    const logos = page.images.filter((img) => img.isLogo || /logo/i.test(img.url) || /logo/i.test(img.context || ''));
    if (logos.length) pool = logos;
  }

  if (spec.type === 'image_list' || spec.plural) {
    const gallery = rankForGallery(pool, { exclude: [] });
    gallery.forEach((img, i) => {
      out.push({
        value: img.url,
        confidence: Math.min(0.9, 0.55 + img.trust * 0.35 + (img.inGallery ? 0.08 : 0)),
        method: `image:${img.channel}`,
        selector: img.selector,
        context: img.context,
        order: 10 + i,
      });
    });
  } else {
    const ranked = rankForMain(pool);
    ranked.forEach((img, i) => {
      out.push({
        value: img.url,
        confidence: Math.min(0.95, img.mainScore),
        method: `image:${img.channel}`,
        selector: img.selector,
        context: img.context,
        order: 10 + i,
      });
    });
  }
  return out;
}

/* -------------------------------------------------------- tier 4b: regex */

function fromRegex(page, spec, regex, { join = false } = {}) {
  const out = [];
  const haystacks = [
    { text: page.text, boilerplate: false, weight: 1 },
    // Chrome text separately, so a footer phone is still found but ranked lower.
    { text: [...page.boilerplate].join('\n'), boilerplate: true, weight: 0.85 },
  ];

  for (const { text, boilerplate, weight } of haystacks) {
    if (!text) continue;
    const matches = [...text.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`))];
    if (join && matches.length) {
      out.push({
        value: matches.map((m) => squish(m[0])).join('; '),
        confidence: TIER.regex * weight,
        method: 'pattern match over page text (joined)',
        boilerplate,
        order: 12,
      });
      continue;
    }
    matches.slice(0, 12).forEach((m, i) => {
      const at = m.index ?? 0;
      const context = text.slice(Math.max(0, at - 90), at + m[0].length + 40);
      // Context words lift a bare number into a confident phone/price.
      const contextScore = contextMatchesSpec(context, spec) ? 1.15 : 0.8;
      out.push({
        value: m[0],
        confidence: Math.min(0.68, TIER.regex * weight * contextScore),
        method: 'pattern match over page text',
        context,
        boilerplate,
        order: 12 + i,
      });
    });
  }
  return out;
}

/* ------------------------------------------------------------- helpers */

/**
 * How well a DOM label matches the field spec, in [0, 1.1].
 * 0 means no match, so the caller skips the candidate entirely.
 */
export function labelMatchScore(domLabel, spec) {
  const text = squish(domLabel).toLowerCase().replace(/[:：]\s*$/, '');
  if (!text || text.length > 80) return 0;
  const domTokens = tokens(text);
  if (!domTokens.length) return 0;

  const specTokens = tokens(spec.label);
  if (text === spec.label.toLowerCase()) return 1.1;

  // Every keyword is a possible spelling of this field.
  for (const kw of spec.exclusive ? spec.labelKeywords ?? [] : spec.keywords) {
    if (!kw || kw.length < 2) continue;
    if (text === kw) return 1.05;
  }

  const overlapWithLabel = tokenOverlap(specTokens, domTokens);
  if (overlapWithLabel >= 0.99) return 1;

  // For an `exclusive` spec (mutually exclusive roles, see ontology.js) only
  // the label's own words may qualify a match.
  const vocabulary = spec.exclusive ? spec.labelKeywords ?? specTokens : spec.keywords;
  const keywordTokens = vocabulary.filter((k) => k.length >= 3);
  const kwHits = keywordTokens.filter((k) => domTokens.includes(k) || text.includes(k));
  if (kwHits.length) {
    // A single short keyword hit inside a long label is weak evidence.
    const specificity = Math.max(...kwHits.map((k) => k.length)) / 12;
    const density = kwHits.length / Math.max(1, domTokens.length);
    return Math.min(1, 0.45 + Math.min(0.3, specificity * 0.3) + Math.min(0.25, density * 0.5));
  }

  if (overlapWithLabel >= 0.5) return 0.6 * overlapWithLabel;

  const sim = similarity(text, spec.label);
  return sim >= 0.7 ? sim * 0.7 : 0;
}

/**
 * Contact channels that are genuinely different things, not synonyms.
 * A page's `telephone` is not its fax number, and vice versa.
 */
const NARROW_CHANNELS = ['fax', 'whatsapp', 'viber', 'telegram', 'wechat', 'skype', 'hotline'];

/**
 * Narrow channels named in the label *itself*.
 *
 * It must be the label, not `spec.keywords`: the ontology's phone entry lists
 * "whatsapp" as a synonym so that a WhatsApp number can satisfy a phone label,
 * which would otherwise make every phone label look narrow.
 */
function narrowTermsFor(spec) {
  const labelTokens = tokens(spec.label);
  return NARROW_CHANNELS.filter((c) => labelTokens.includes(c));
}

/**
 * Does surrounding text look like it is about this field?
 * `requireForNarrow` makes the check mandatory for labels that must not grab
 * the generic value, and conversely stops a plain "Phone" label from taking a
 * number explicitly marked as a fax.
 */
function contextMatchesSpec(context, spec, { requireForNarrow = false } = {}) {
  const text = squish(context).toLowerCase();
  const specNarrow = narrowTermsFor(spec);

  if (requireForNarrow && specNarrow.length) {
    return specNarrow.some((k) => text.includes(k));
  }
  if (requireForNarrow) {
    const conflicting = NARROW_CHANNELS.filter((k) => !specNarrow.includes(k));
    if (conflicting.some((k) => text.includes(k))) return false;
    return true;
  }
  return spec.keywords.some((k) => k.length >= 3 && text.includes(k));
}

/** Split a single cell that holds several values ("WiFi, Pool, Parking"). */
function splitList(value) {
  const s = squish(value);
  if (s.length < 8) return [s];
  const parts = s.split(/\s*[,;•·|•·–]\s*|\s{3,}|\s*\/\s*(?=[A-Z])/).map((p) => squish(p)).filter(Boolean);
  return parts.length >= 2 && parts.every((p) => p.length <= 80) ? parts : [s];
}

function selectorOf($, el) {
  const $el = $(el);
  const tag = ($el.prop('tagName') || 'node').toLowerCase();
  const id = $el.attr('id');
  if (id) return `${tag}#${id}`;
  const cls = ($el.attr('class') || '').split(/\s+/).filter(Boolean).slice(0, 2);
  return cls.length ? `${tag}.${cls.join('.')}` : tag;
}

function parentContext($, el) {
  const $p = $(el).parent();
  return squish([$p.attr('class'), $p.attr('id'), $p.prev().text()].filter(Boolean).join(' '));
}
