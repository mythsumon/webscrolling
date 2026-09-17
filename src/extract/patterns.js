/**
 * Per-value-kind regexes, validators and normalisers.
 *
 * This file is the accuracy backstop. Every candidate value from every
 * extractor passes through `validate(type, value)` before it can be returned,
 * which is what stops a date being reported as a phone number or a nav link
 * being reported as an address.
 */

import { squish } from '../util/text.js';

/* ------------------------------------------------------------------ phones */

// Deliberately permissive at the match stage; `validatePhone` does the rejecting.
export const PHONE_RE =
  /(?:\+|00)?[\d][\d\s().\-–—/]{6,20}\d/g;

const PHONE_CONTEXT_RE = /(phone|tel|telephone|mobile|cell|call|whatsapp|viber|fax|hotline|contact)/i;

/**
 * Display form: tidy the whitespace and separators, keep the grouping.
 *
 * The number a site prints ("09-421116317", "+95 9 7712 3456") is the number a
 * human wants back. Flattening it to digits is lossy in a way that matters for
 * national formats, where a leading 0 and the grouping carry dialling meaning.
 * Canonicalisation is still needed — but only for comparison, which is what
 * `canonicalPhone` below is for.
 */
export function normalizePhone(value) {
  const s = squish(value)
    .replace(/[–—]/g, '-')
    .replace(/^tel:/i, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*-\s*/g, '-')
    .trim();
  return s || null;
}

/** Comparison form: digits only, keeping a leading + for international. */
export function canonicalPhone(value) {
  const s = squish(value).replace(/^tel:/i, '').replace(/\bext\.?\s*\d+$/i, '');
  const hasPlus = s.trimStart().startsWith('+') || /^00\d/.test(s);
  const digits = s.replace(/\D/g, '').replace(/^00/, '');
  if (!digits) return null;
  return hasPlus ? `+${digits}` : digits;
}

export function validatePhone(value, { context = '' } = {}) {
  const s = squish(value);
  if (!s) return false;
  const digits = s.replace(/\D/g, '');
  // E.164: 7..15 digits. Below 7 is an extension; above 15 is an id.
  if (digits.length < 7 || digits.length > 16) return false;

  // Reject things that are shaped like other data.
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) return false;          // ISO date
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(s.trim())) return false; // d/m/y
  if (/\b(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}\b/.test(s)) return false; // year range
  if (/[€$£¥₹]|\b(usd|eur|gbp|mmk|thb|jpy)\b/i.test(s)) return false; // price
  if (/\b(am|pm)\b/i.test(s) && digits.length <= 8) return false;      // opening hours
  if (/^\d+(\.\d+)?%$/.test(s)) return false;

  // A long run of digits with no separators and no leading + is an id, an
  // ISBN, a registration or an order number — not a phone number. No amount
  // of nearby context makes a 13-digit unbroken run dialable.
  const hasStructure = /[+\-().\s]/.test(s);
  if (!hasStructure && digits.length > 11) return false;
  // 10-11 unstructured digits (e.g. "09771234567") do occur, but only count
  // when something nearby says it is a phone.
  if (!hasStructure && digits.length >= 10 && !PHONE_CONTEXT_RE.test(context)) return false;

  // All-same or fully sequential digits are placeholders (0000000, 123456789).
  // The check must cover the whole number: "(01) 234 5678" is a real phone
  // whose digits merely start out looking sequential.
  if (/^(\d)\1{6,}$/.test(digits)) return false;
  if (isSequential(digits)) return false;

  return true;
}

/* ------------------------------------------------------------------ emails */

export const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}/g;

const EMAIL_BLOCKLIST =
  /@(example|test|domain|yourdomain|email|sentry|sentry\.io|wixpress|localhost|mysite|site)\b|\.(png|jpe?g|gif|webp|css|js)$|^(no-?reply|postmaster|abuse|webmaster)@/i;

export function normalizeEmail(value) {
  const s = squish(value).replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
  return s || null;
}

/** Is every digit one more than the previous one, across the whole string? */
function isSequential(digits) {
  for (let i = 1; i < digits.length; i += 1) {
    if (Number(digits[i]) !== Number(digits[i - 1]) + 1) return false;
  }
  return digits.length >= 7;
}

export function validateEmail(value) {
  const s = normalizeEmail(value);
  if (!s) return false;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(s)) return false;
  if (EMAIL_BLOCKLIST.test(s)) return false;
  if (s.length > 254) return false;
  // Image sprite filenames sometimes look like emails after @2x mangling.
  if (/@\d+x\./.test(s)) return false;
  return true;
}

/* -------------------------------------------------------------------- urls */

export function validateUrlValue(value) {
  const s = squish(value);
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ prices */

/**
 * ISO currency codes and symbols, in one place so the matcher and the
 * validator can never disagree (they did: "NZD 240" matched but failed to
 * validate, and the field came back null).
 */
const CURRENCY_CODES =
  'USD|EUR|GBP|JPY|CHF|CNY|HKD|TWD|KRW|SGD|MYR|IDR|THB|VND|PHP|MMK|KHR|LAK|BND|INR|PKR|BDT|LKR|NPR|AED|SAR|QAR|KWD|BHD|OMR|ILS|TRY|EGP|MAD|ZAR|NGN|KES|GHS|TZS|UGX|AUD|NZD|CAD|MXN|BRL|ARS|CLP|COP|PEN|UYU|RUB|UAH|PLN|CZK|HUF|RON|BGN|SEK|NOK|DKK|ISK|KZT';
const CURRENCY_SYMBOLS = '\\$€£¥₹₩฿₦₱₪₫₭₲₴₸₺₼₽₡₵₾֏؋৳﷼';

export const CURRENCY_RE = new RegExp(
  `[${CURRENCY_SYMBOLS}]|\\b(?:${CURRENCY_CODES})\\b|\\bRs\\.?|\\bKs\\.?`,
  'i',
);

export const PRICE_RE = new RegExp(
  `(?:(?:US\\$|[${CURRENCY_SYMBOLS}]|\\b(?:${CURRENCY_CODES})\\b)\\s?\\d[\\d,.\\s]*(?:\\.\\d{1,2})?` +
    `|\\d[\\d,.]*\\s?(?:US\\$|[${CURRENCY_SYMBOLS}]|\\b(?:${CURRENCY_CODES})\\b))` +
    `(?:\\s?(?:per|/)\\s?(?:night|day|month|year|person|pax|room|week|hour|guest|adult))?`,
  'gi',
);

export function validatePrice(value) {
  const s = squish(value);
  if (!s || s.length > 60) return false;
  if (/free|call for|on request|tbd|n\/a/i.test(s) && !/\d/.test(s)) return false;
  // Must carry either a currency marker or be a bare number in a price field.
  const hasCurrency = CURRENCY_RE.test(s);
  const hasNumber = /\d/.test(s);
  if (!hasNumber) return false;
  if (!hasCurrency && !/^\d[\d,.]*(\.\d{1,2})?$/.test(s)) return false;
  // Reject years and phone-like runs.
  if (/^(19|20)\d{2}$/.test(s)) return false;
  if (s.replace(/\D/g, '').length > 12) return false;
  return true;
}

export function normalizePrice(value) {
  return squish(value).replace(/\s+/g, ' ');
}

/* --------------------------------------------------------------- geo coords */

export function validateLatitude(value) {
  const n = Number(squish(value));
  return Number.isFinite(n) && Math.abs(n) <= 90 && String(squish(value)).length <= 24;
}

export function validateLongitude(value) {
  const n = Number(squish(value));
  return Number.isFinite(n) && Math.abs(n) <= 180 && String(squish(value)).length <= 24;
}

/** `@21.9588,96.0891` and `!3d21.9588!4d96.0891` appear in embedded map URLs. */
export function extractGeoFromUrl(url) {
  if (!url) return null;
  const at = url.match(/[@!]?(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/);
  if (at) return { latitude: at[1], longitude: at[2] };
  const d3 = url.match(/!3d(-?\d{1,3}\.\d+).*?!4d(-?\d{1,3}\.\d+)/);
  if (d3) return { latitude: d3[1], longitude: d3[2] };
  const q = url.match(/[?&](?:q|ll|center|sll)=(-?\d{1,3}\.\d{3,})[,%2C]+(-?\d{1,3}\.\d{3,})/i);
  if (q) return { latitude: q[1], longitude: q[2] };
  return null;
}

/* ----------------------------------------------------------------- address */

const ADDRESS_HINT_RE =
  /\d|\b(street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|highway|hwy|suite|ste\.?|floor|fl\.?|unit|block|building|bldg|township|quarter|ward|district|city|town|village|state|province|region|county|country|zip|postcode|postal)\b/i;

export function validateAddress(value) {
  const s = squish(value);
  if (s.length < 8 || s.length > 300) return false;
  if (!ADDRESS_HINT_RE.test(s)) return false;
  // Reject nav dumps and sentence prose masquerading as an address.
  if ((s.match(/\|/g) || []).length > 2) return false;
  if (s.split(/\s+/).length > 45) return false;
  if (/\b(cookie|privacy policy|terms|copyright|all rights reserved|subscribe)\b/i.test(s)) return false;
  return true;
}

export function normalizeAddress(value) {
  return squish(value)
    .replace(/\s*,\s*/g, ', ')
    .replace(/(,\s*)+/g, ', ')
    .replace(/^,\s*|,\s*$/g, '')
    .replace(/\s*\n\s*/g, ', ');
}

/* ----------------------------------------------------------- opening hours */

export const HOURS_RE =
  /(?:mon|tue|wed|thu|fri|sat|sun|daily|weekday|weekend)[a-z]*\.?\s*(?:[-–—to]+\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?)?\s*:?\s*(?:\d{1,2}[:.]?\d{0,2}\s*(?:am|pm)?\s*[-–—to]+\s*\d{1,2}[:.]?\d{0,2}\s*(?:am|pm)?|closed|24\s*hours|open\s*24)/gi;

export function validateHours(value) {
  const s = squish(value);
  if (s.length < 5 || s.length > 400) return false;
  return /\d|closed|24\s*hours/i.test(s) &&
    /(mon|tue|wed|thu|fri|sat|sun|daily|weekday|weekend|open|closed|am|pm|\d{1,2}:\d{2})/i.test(s);
}

/* ------------------------------------------------------------------ social */

export const SOCIAL_HOSTS = {
  facebook: /(?:^|\.)(facebook\.com|fb\.com|fb\.me)$/i,
  instagram: /(?:^|\.)instagram\.com$/i,
  twitter: /(?:^|\.)(twitter\.com|x\.com)$/i,
  linkedin: /(?:^|\.)linkedin\.com$/i,
  youtube: /(?:^|\.)(youtube\.com|youtu\.be)$/i,
  tiktok: /(?:^|\.)tiktok\.com$/i,
  pinterest: /(?:^|\.)pinterest\.[a-z.]+$/i,
  telegram: /(?:^|\.)(t\.me|telegram\.me)$/i,
  whatsapp: /(?:^|\.)(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)$/i,
  tripadvisor: /(?:^|\.)tripadvisor\.[a-z.]+$/i,
  booking: /(?:^|\.)booking\.com$/i,
  yelp: /(?:^|\.)yelp\.[a-z.]+$/i,
};

/** Is this URL a profile on `network`, rather than a share/intent link? */
export function isSocialProfile(url, network) {
  const re = SOCIAL_HOSTS[network];
  if (!re) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!re.test(u.hostname)) return false;
  // Share widgets and intents are not the business's own profile.
  if (/\/(sharer?|share|intent|dialog|plugins|oauth|login|signup|home|search)\b/i.test(u.pathname)) return false;
  if (u.pathname === '/' || u.pathname === '') return false;
  return true;
}

/* ------------------------------------------------------------- generic text */

const BOILERPLATE_RE =
  /^(read more|learn more|click here|home|menu|search|close|next|previous|back|submit|send|subscribe|accept|cookie|share|follow us|view all|see more|show more|load more|toggle navigation|skip to (?:main )?content)$/i;

export function validateText(value, { minLength = 2, maxLength = 400 } = {}) {
  const s = squish(value);
  if (s.length < minLength || s.length > maxLength) return false;
  if (BOILERPLATE_RE.test(s)) return false;
  // A value that is mostly punctuation is markup residue.
  const letters = (s.match(/[\p{L}\p{N}]/gu) || []).length;
  if (letters / s.length < 0.5) return false;
  return true;
}

export function validateDescription(value) {
  const s = squish(value);
  return s.length >= 30 && s.length <= 5000 && /\s/.test(s) && !BOILERPLATE_RE.test(s);
}

export function validateNumber(value) {
  const s = squish(value);
  return /^[\d.,\s]+$/.test(s) && Number.isFinite(Number(s.replace(/[\s,]/g, '')));
}

export function validateRating(value) {
  const s = squish(value);
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return false;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

/* ------------------------------------------------------- dispatch table */

/** @type {Record<string, (value: string, ctx?: object) => boolean>} */
export const VALIDATORS = {
  text: validateText,
  name: (v) => validateText(v, { minLength: 2, maxLength: 160 }),
  description: validateDescription,
  address: validateAddress,
  phone: validatePhone,
  email: validateEmail,
  url: validateUrlValue,
  image: validateUrlValue,
  image_list: validateUrlValue,
  price: validatePrice,
  latitude: validateLatitude,
  longitude: validateLongitude,
  hours: validateHours,
  social: validateUrlValue,
  rating: validateRating,
  number: validateNumber,
  list: (v) => validateText(v, { minLength: 2, maxLength: 200 }),
  date: (v) => squish(v).length >= 4 && squish(v).length <= 80,
};

/** @type {Record<string, (value: string) => string|null>} */
export const NORMALIZERS = {
  phone: normalizePhone,
  email: normalizeEmail,
  price: normalizePrice,
  address: normalizeAddress,
};

export function validate(type, value, ctx) {
  const fn = VALIDATORS[type] ?? VALIDATORS.text;
  try {
    return fn(value, ctx);
  } catch {
    return false;
  }
}

/**
 * Normalise for output. Phones keep their readable original *and* gain a
 * canonical form, so we never destroy the source formatting.
 */
export function normalizeForOutput(type, value) {
  const fn = NORMALIZERS[type];
  if (!fn) return squish(value);
  const out = fn(value);
  return out ?? squish(value);
}

/** Canonical comparison key for dedupe (e.g. two spellings of one phone). */
export function identityKey(type, value) {
  // Comparison uses the canonical digits, so "09-421116317" and "09 421116317"
  // are one number even though both display forms are preserved on output.
  if (type === 'phone') return canonicalPhone(value) ?? squish(value).toLowerCase();
  if (type === 'email') return normalizeEmail(value) ?? squish(value).toLowerCase();
  if (type === 'url' || type === 'image' || type === 'image_list' || type === 'social') {
    return squish(value).replace(/\/+$/, '').toLowerCase();
  }
  return squish(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
