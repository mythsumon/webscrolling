/**
 * Label -> field spec.
 *
 * This is the module that makes the engine label-agnostic. It never rejects a
 * label: an unknown label gets a type inferred from its head noun and keywords
 * taken from its own words, so "Warranty Period" or "Menu Image" behave
 * sensibly without anyone adding them to the ontology.
 */

import { ONTOLOGY, ALIAS_INDEX } from './ontology.js';
import { squish, tokens, toKey, similarity, tokenOverlap } from '../util/text.js';

/**
 * @typedef {object} FieldSpec
 * @property {string} label       exactly as the user typed it
 * @property {string} key         snake_case output key
 * @property {string} type        value kind (see patterns.js VALIDATORS)
 * @property {boolean} plural     array output?
 * @property {string[]} keywords  DOM/text search vocabulary
 * @property {string[]} schemaKeys JSON-LD / microdata property names
 * @property {string[]} metaKeys  <meta> names
 * @property {string[]} attrHints class/id substrings
 * @property {string[]} pageHints URL path words worth following
 * @property {string|null} ontologyKey  which entry matched, or null if inferred
 * @property {string|null} social  social network id, when type === 'social'
 * @property {number} matchScore  how confident the ontology match was
 */

/** Head-noun -> type rules for labels the ontology does not know. */
const TYPE_INFERENCE = [
  // Plural first, and strictly plural: "Images" is a list, "Image" is not.
  { re: /\b(images|photos|pictures|gallery|galleries|pics|photographs|media)\b/i, type: 'image_list', plural: true },
  { re: /\b(image|photo|picture|pic|thumbnail|thumb|logo|banner|cover|poster|screenshot|avatar)\b/i, type: 'image' },
  { re: /\b(e-?mails?)\b/i, type: 'email' },
  { re: /\b(phones?|telephones?|tel|mobiles?|cells?|faxe?s?|hotlines?|whatsapp|viber)\b/i, type: 'phone' },
  { re: /\b(urls?|websites?|links?|homepages?|web\s?sites?|domains?)\b/i, type: 'url' },
  { re: /\b(prices?|costs?|rates?|fees?|tariffs?|charges?|pricing|amounts?|salary|salaries|budget)\b/i, type: 'price' },
  { re: /\b(addresses?|locations?)\b/i, type: 'address' },
  { re: /\b(latitude|lat)\b/i, type: 'latitude' },
  { re: /\b(longitude|lng|lon)\b/i, type: 'longitude' },
  { re: /\b(hours?|schedules?|timings?|opening|availability\s+hours)\b/i, type: 'hours' },
  { re: /\b(ratings?|scores?|stars?)\b/i, type: 'rating' },
  { re: /\b(counts?|totals?|quantity|number\s+of|size|capacity|years?|age|floors?|rooms?\s+count|beds?)\b/i, type: 'number' },
  { re: /\b(dates?|published|founded|established|since|deadline|expiry|period)\b/i, type: 'date' },
  { re: /\b(descriptions?|about|summary|summaries|overview|bio|biography|details|introduction|story)\b/i, type: 'description' },
  { re: /\b(names?|titles?|brands?|headlines?)\b/i, type: 'name' },
  { re: /\b(amenities|facilities|features|services|tags|categories|options|specifications|specs|inclusions|benefits|highlights|types?)\b/i, type: 'list', plural: true },
];

/** Words that imply array output even without an ontology hit. */
const PLURAL_RE =
  /\b(\w+s|\w+es|amenities|facilities|galleries|all|list|multiple|every|each)\b\s*$/i;

const SINGULAR_EXCEPTIONS = new Set([
  'address', 'business', 'status', 'press', 'access', 'class', 'gps', 'series', 'news',
  'bonus', 'campus', 'focus', 'plus', 'prices',
]);

/** Detect the social-network flavour of a label, if any. */
function detectSocial(label) {
  const l = label.toLowerCase();
  const map = {
    facebook: /\bfacebook\b|\bfb\b/,
    instagram: /\binstagram\b|\binsta\b|\big\b/,
    twitter: /\btwitter\b|\bx\.com\b|(^|\s)x(\s|$)/,
    linkedin: /\blinkedin\b/,
    youtube: /\byoutube\b|\byt\b/,
    tiktok: /\btik\s?tok\b/,
    pinterest: /\bpinterest\b/,
    telegram: /\btelegram\b/,
    whatsapp: /\bwhats\s?app\b/,
    tripadvisor: /\btrip\s?advisor\b/,
    booking: /\bbooking\.com\b/,
    yelp: /\byelp\b/,
  };
  for (const [net, re] of Object.entries(map)) if (re.test(l)) return net;
  return null;
}

function isPlural(label, inferredType) {
  if (inferredType === 'image_list' || inferredType === 'list') return true;
  const last = tokens(label, { keepStopwords: true }).at(-1) ?? '';
  if (SINGULAR_EXCEPTIONS.has(last)) return false;
  if (/^(images?|photos?)$/i.test(last)) return /s$/i.test(last);
  return PLURAL_RE.test(squish(label)) && /s$/i.test(last);
}

/** Best ontology match for a label, or null. */
function matchOntology(label) {
  const norm = squish(label).toLowerCase();
  if (!norm) return null;

  // 1. exact alias
  const exact = ALIAS_INDEX.get(norm);
  if (exact) return { key: exact, score: 1 };

  // 2. alias with punctuation/plural noise removed
  const loose = norm.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (ALIAS_INDEX.has(loose)) return { key: ALIAS_INDEX.get(loose), score: 0.98 };
  const depluralised = loose.replace(/\b(\w+)s\b/g, '$1');
  if (ALIAS_INDEX.has(depluralised)) return { key: ALIAS_INDEX.get(depluralised), score: 0.9 };

  // 3. token overlap / substring / trigram against every alias
  const labelTokens = tokens(norm);
  let best = null;
  for (const [alias, key] of ALIAS_INDEX) {
    const aliasTokens = tokens(alias);
    let score = 0;

    const overlap = tokenOverlap(aliasTokens, labelTokens);
    const reverse = tokenOverlap(labelTokens, aliasTokens);
    // Require the alias to be substantially covered, so "Room Price" does not
    // match the alias "room" and become a list of room types.
    if (overlap >= 0.75 && aliasTokens.length > 0) {
      score = 0.6 + 0.2 * overlap + 0.1 * reverse;
    }
    if (norm.includes(alias) && alias.length >= 4) {
      score = Math.max(score, 0.7 + Math.min(0.15, alias.length / 100));
    }
    const sim = similarity(norm, alias);
    if (sim >= 0.55) score = Math.max(score, sim * 0.8);

    if (score > 0 && (!best || score > best.score)) best = { key, score };
  }
  return best && best.score >= 0.55 ? best : null;
}

/** Type inferred from the label's own words, for unknown labels. */
function inferType(label) {
  for (const rule of TYPE_INFERENCE) {
    if (rule.re.test(label)) return { type: rule.type, plural: rule.plural ?? false };
  }
  return { type: 'text', plural: false };
}

/**
 * Build a field spec from one user label.
 * @param {string} label
 * @returns {FieldSpec}
 */
export function parseLabel(label) {
  const clean = squish(label);
  const social = detectSocial(clean);
  const match = matchOntology(clean);
  const inferred = inferType(clean);
  const entry = match ? ONTOLOGY[match.key] : null;

  // An ontology hit outranks social-network detection, because some networks
  // are also phone channels: "WhatsApp Number" is a phone, "Facebook" is a URL.
  // With no ontology hit, a network name means "give me that profile URL".
  const type = entry ? entry.type : social ? 'social' : inferred.type;

  const labelTokens = tokens(clean);
  const exclusive = entry?.exclusive ?? false;
  // The label's own words, plus singular forms. For `exclusive` entries these
  // are the only words allowed to qualify a match.
  const labelKeywords = unique([
    ...labelTokens,
    ...labelTokens.map((t) => t.replace(/ies$/, 'y').replace(/s$/, '')).filter((t) => t.length > 2),
  ]);
  const keywords = unique([
    ...labelTokens,
    ...(entry?.keywords ?? []),
    ...(social ? [social] : []),
    // Depluralised forms, so "Amenities" also matches "amenity".
    ...labelTokens.map((t) => t.replace(/ies$/, 'y').replace(/s$/, '')).filter((t) => t.length > 2),
  ]);

  const plural = entry?.plural ?? (inferred.plural || isPlural(clean, type));

  return {
    label: clean,
    key: toKey(clean),
    type: plural && type === 'image' ? 'image_list' : type,
    plural: plural || type === 'image_list' || type === 'list',
    keywords,
    schemaKeys: unique([
      ...(entry?.schemaKeys ?? []),
      // Camel/lower variants of the label itself catch bespoke JSON-LD keys.
      clean.replace(/\s+/g, ''),
      labelTokens.join(''),
      labelTokens.at(-1) ?? '',
    ].filter(Boolean)),
    labelKeywords,
    exclusive,
    metaKeys: unique(entry?.metaKeys ?? []),
    schemaEntityTypes: unique(entry?.schemaEntityTypes ?? []),
    attrHints: exclusive
      ? labelKeywords.filter((t) => t.length > 2)
      : unique([...(entry?.attrHints ?? []), ...labelTokens.filter((t) => t.length > 2)]),
    pageHints: unique(entry?.pageHints ?? []),
    ontologyKey: match?.key ?? null,
    social,
    matchScore: match?.score ?? 0,
  };
}

/**
 * Parse a list of labels, dropping blanks and collapsing duplicate keys.
 * @param {string[]} labels
 * @returns {FieldSpec[]}
 */
export function parseLabels(labels) {
  const specs = [];
  const seen = new Set();
  for (const raw of labels ?? []) {
    const clean = squish(raw);
    if (!clean) continue;
    const spec = parseLabel(clean);
    if (seen.has(spec.key)) continue;
    seen.add(spec.key);
    specs.push(spec);
  }
  return specs;
}

function unique(arr) {
  return [...new Set(arr.map((s) => String(s).toLowerCase().trim()).filter(Boolean))];
}
