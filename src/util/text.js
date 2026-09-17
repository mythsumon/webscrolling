/**
 * Text normalisation, tokenisation and fuzzy similarity.
 *
 * These are the primitives label matching is built on. They must be cheap:
 * `similarity` runs once per (label, candidate-key) pair, which can be
 * thousands of pairs on a large JSON-LD blob.
 */

/** Collapse all whitespace kinds (incl. NBSP) and trim. */
export function squish(text) {
  if (text == null) return '';
  return String(text)
    .replace(/[  -​  　]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Squish, but keep paragraph breaks — used for descriptions. */
export function squishBlock(text) {
  if (text == null) return '';
  return String(text)
    .replace(/[  -​  　]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'at', 'by',
  'with', 'our', 'your', 'us', 'we', 'is', 'are', 'be', 'no', 'number',
]);

/**
 * Lowercase alphanumeric tokens with stopwords removed.
 * "Phone Number" -> ["phone"]  (so it matches a "Phone:" label in the DOM)
 */
export function tokens(text, { keepStopwords = false } = {}) {
  const raw = squish(text)
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const out = keepStopwords ? raw : raw.filter((t) => !STOPWORDS.has(t));
  return out.length ? out : raw;
}

/** snake_case output key, stable for a given label. */
export function toKey(label) {
  const k = squish(label)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return k || 'field';
}

function trigrams(s) {
  const padded = `  ${s} `;
  const set = new Set();
  for (let i = 0; i < padded.length - 2; i += 1) set.add(padded.slice(i, i + 3));
  return set;
}

/**
 * Trigram Dice coefficient in [0,1]. Used as the last-resort label matcher, so
 * it is deliberately forgiving of plurals and separators but not of unrelated
 * words ("phone" vs "photo" scores ~0.3, below the 0.55 threshold).
 */
export function similarity(a, b) {
  const x = squish(a).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const y = squish(b).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ta = trigrams(x);
  const tb = trigrams(y);
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared += 1;
  return (2 * shared) / (ta.size + tb.size);
}

/** Fraction of `needles` present in `haystack` (both token arrays). */
export function tokenOverlap(needles, haystack) {
  if (!needles.length) return 0;
  const set = new Set(haystack);
  let hit = 0;
  for (const n of needles) if (set.has(n)) hit += 1;
  return hit / needles.length;
}

/** Case/whitespace-insensitive dedupe that preserves first-seen order. */
export function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = squish(v);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** True when `a` is a case-insensitive substring of `b` (for LLM grounding). */
export function containsText(haystack, needle) {
  const h = squish(haystack).toLowerCase();
  const n = squish(needle).toLowerCase();
  return n.length > 0 && h.includes(n);
}

export function truncate(text, max) {
  const s = squish(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
