/**
 * Google Places source — the supported way to get "the list from Google Maps".
 *
 * WHY THIS INSTEAD OF SCRAPING MAPS
 * Google's robots.txt actually permits /maps/search/, so the crawler would not
 * refuse it. Two other things rule it out: Google's Terms of Service prohibit
 * automated extraction of Maps content, and the results live in a virtualised
 * JS panel behind bot detection, so making it work would mean building evasion
 * rather than extraction. The Places API returns the same businesses as
 * structured fields, which is both permitted and strictly better data.
 *
 * Shape: this module produces records in exactly the same form as the
 * scraper's list mode, so the record table, per-label coverage and the
 * JSON/CSV exporters all work on it unchanged.
 *
 * Billing: every search is a billed API call against the caller's own key, and
 * so is every photo URL resolved. Requests are therefore capped and the field
 * mask is built from the labels actually asked for — Google bills by which
 * fields you request, so asking for everything costs more.
 *
 * Verified against the current docs (2026-09):
 *   POST https://places.googleapis.com/v1/places:searchText
 *        headers: X-Goog-Api-Key, X-Goog-FieldMask
 *        body: { textQuery, pageSize (max 20), pageToken, languageCode, ... }
 *   GET  https://places.googleapis.com/v1/{photo.name}/media
 *        ?maxHeightPx=…&skipHttpRedirect=true&key=…  -> { name, photoUri }
 */

import { assembleListResult } from '../output/result.js';
import { parseLabels } from '../extract/labels.js';
import { squish } from '../util/text.js';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const PHOTO_BASE = 'https://places.googleapis.com/v1';

/** Google's own ceilings: 20 results per page, 60 in total. */
export const PAGE_SIZE = 20;
export const MAX_RESULTS = 60;

/**
 * Label kinds -> Places fields.
 *
 * `mask` is the field-mask entry to request; `read` pulls the value out of a
 * place object. `match` decides whether a user label wants this field: it is
 * checked against the label's own words first, then its inferred value type,
 * so both "Phone Number" and "Tel" land on the same field.
 */
const FIELDS = [
  {
    key: 'name',
    mask: 'places.displayName',
    match: ({ words, type }) => words.some((w) => ['name', 'title', 'business', 'place', 'shop', 'store'].includes(w)) || type === 'name',
    read: (p) => squish(p.displayName?.text),
  },
  {
    key: 'address',
    mask: 'places.formattedAddress',
    match: ({ words, type }) => words.some((w) => ['address', 'location', 'street'].includes(w)) || type === 'address',
    read: (p) => squish(p.formattedAddress),
  },
  {
    key: 'phone_international',
    mask: 'places.internationalPhoneNumber',
    match: ({ words }) => words.includes('international') && words.some((w) => ['phone', 'tel', 'telephone', 'number'].includes(w)),
    read: (p) => squish(p.internationalPhoneNumber),
  },
  {
    key: 'phone',
    mask: 'places.nationalPhoneNumber,places.internationalPhoneNumber',
    match: ({ words, type }) => words.some((w) => ['phone', 'tel', 'telephone', 'mobile', 'contact'].includes(w)) || type === 'phone',
    read: (p) => squish(p.nationalPhoneNumber || p.internationalPhoneNumber),
  },
  {
    key: 'website',
    mask: 'places.websiteUri',
    match: ({ words, type }) => words.some((w) => ['website', 'web', 'site', 'url', 'homepage'].includes(w)) || type === 'url',
    read: (p) => squish(p.websiteUri),
  },
  {
    key: 'maps_url',
    mask: 'places.googleMapsUri',
    match: ({ words }) => words.includes('maps') || (words.includes('google') && words.includes('link')),
    read: (p) => squish(p.googleMapsUri),
  },
  {
    key: 'rating',
    mask: 'places.rating',
    match: ({ words, type }) => words.some((w) => ['rating', 'stars', 'score', 'rated'].includes(w)) || type === 'rating',
    read: (p) => (typeof p.rating === 'number' ? String(p.rating) : null),
  },
  {
    key: 'review_count',
    mask: 'places.userRatingCount',
    match: ({ words }) => words.some((w) => ['review', 'reviews', 'ratings'].includes(w)) && !words.includes('rating'),
    read: (p) => (typeof p.userRatingCount === 'number' ? String(p.userRatingCount) : null),
  },
  {
    key: 'latitude',
    mask: 'places.location',
    match: ({ words, type }) => words.some((w) => ['latitude', 'lat'].includes(w)) || type === 'latitude',
    read: (p) => (typeof p.location?.latitude === 'number' ? String(p.location.latitude) : null),
  },
  {
    key: 'longitude',
    mask: 'places.location',
    match: ({ words, type }) => words.some((w) => ['longitude', 'lng', 'lon'].includes(w)) || type === 'longitude',
    read: (p) => (typeof p.location?.longitude === 'number' ? String(p.location.longitude) : null),
  },
  {
    key: 'opening_hours',
    mask: 'places.regularOpeningHours',
    match: ({ words, type }) => words.some((w) => ['hours', 'opening', 'schedule', 'timing', 'open'].includes(w)) || type === 'hours',
    read: (p) => {
      const days = p.regularOpeningHours?.weekdayDescriptions;
      return Array.isArray(days) && days.length ? days.join('; ') : null;
    },
  },
  {
    key: 'category',
    mask: 'places.types,places.primaryTypeDisplayName',
    match: ({ words, type }) => words.some((w) => ['category', 'type', 'types', 'cuisine', 'kind'].includes(w)) || type === 'list',
    read: (p) => {
      const primary = squish(p.primaryTypeDisplayName?.text);
      if (primary) return primary;
      // `types` are machine tokens; make them readable.
      return Array.isArray(p.types) && p.types.length
        ? p.types.map((t) => t.replace(/_/g, ' ')).join(', ')
        : null;
    },
  },
  {
    key: 'price_level',
    mask: 'places.priceLevel',
    match: ({ words, type }) => words.some((w) => ['price', 'cost', 'expensive', 'budget'].includes(w)) || type === 'price',
    read: (p) => (p.priceLevel ? String(p.priceLevel).replace(/^PRICE_LEVEL_/, '').replace(/_/g, ' ').toLowerCase() : null),
  },
  {
    key: 'business_status',
    mask: 'places.businessStatus',
    match: ({ words }) => words.some((w) => ['status', 'open', 'closed', 'operational'].includes(w)),
    read: (p) => (p.businessStatus ? String(p.businessStatus).replace(/_/g, ' ').toLowerCase() : null),
  },
  {
    key: 'place_id',
    mask: 'places.id',
    match: ({ words }) => (words.includes('place') && words.includes('id')) || words.includes('placeid'),
    read: (p) => squish(p.id),
  },
  {
    // Photos need a second, billed request each to turn a resource name into a
    // URL, so they are resolved separately and only when asked for.
    key: 'photo',
    mask: 'places.photos',
    match: ({ words, type }) => words.some((w) => ['image', 'images', 'photo', 'photos', 'picture', 'pictures'].includes(w)) || type === 'image' || type === 'image_list',
    read: () => null,
    photos: true,
  },
];

/**
 * Decide which Places field answers each requested label.
 * @param {import('../extract/labels.js').FieldSpec[]} specs
 * @returns {{assignments: Map<string, object>, fieldMask: string, unmatched: string[], wantsPhotos: boolean}}
 */
export function mapLabelsToFields(specs) {
  const assignments = new Map();
  const unmatched = [];
  const masks = new Set(['places.id']);
  let wantsPhotos = false;

  for (const spec of specs) {
    const words = spec.labelKeywords ?? [];
    // Order matters: the more specific rules sit above the general ones, so
    // "International Phone" is not swallowed by the plain phone rule.
    const field = FIELDS.find((f) => {
      try {
        return f.match({ words, type: spec.type });
      } catch {
        return false;
      }
    });
    if (!field) {
      unmatched.push(spec.label);
      continue;
    }
    assignments.set(spec.key, { spec, field });
    for (const m of field.mask.split(',')) masks.add(m);
    if (field.photos) wantsPhotos = true;
  }

  return {
    assignments,
    fieldMask: [...masks, 'nextPageToken'].join(','),
    unmatched,
    wantsPhotos,
  };
}

/**
 * Run a text search, following pageToken up to `maxResults`.
 * @returns {Promise<{places: object[], errors: object[], warnings: string[], calls: number}>}
 */
export async function searchPlaces({
  query,
  apiKey,
  fieldMask,
  maxResults = PAGE_SIZE,
  languageCode,
  regionCode,
  timeoutMs = 15000,
  fetchImpl = fetch,
}) {
  const places = [];
  const errors = [];
  const warnings = [];
  let pageToken;
  let calls = 0;

  const wanted = Math.min(maxResults, MAX_RESULTS);
  if (maxResults > MAX_RESULTS) {
    warnings.push(`Google returns at most ${MAX_RESULTS} results for a text search; asked for ${maxResults}.`);
  }

  while (places.length < wanted) {
    const body = {
      textQuery: query,
      pageSize: Math.min(PAGE_SIZE, wanted - places.length),
      ...(pageToken ? { pageToken } : {}),
      ...(languageCode ? { languageCode } : {}),
      ...(regionCode ? { regionCode } : {}),
    };

    let res;
    try {
      calls += 1;
      res = await fetchImpl(SEARCH_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      errors.push({
        type: err?.name === 'TimeoutError' ? 'timeout' : 'network',
        message: `Places request failed: ${err?.message ?? err}`,
      });
      break;
    }

    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      errors.push({
        type: placesErrorType(res.status, payload),
        status: res.status,
        message: describePlacesError(res.status, payload),
      });
      break;
    }

    const batch = Array.isArray(payload.places) ? payload.places : [];
    places.push(...batch);
    pageToken = payload.nextPageToken;
    // No token, or a page that returned nothing, means the list is exhausted.
    if (!pageToken || !batch.length) break;
  }

  return { places: places.slice(0, wanted), errors, warnings, calls };
}

/**
 * Google returns 400 — not 403 — for an invalid API key, so the status alone
 * misclassifies the most common setup mistake as a malformed request and sends
 * you looking at the field mask. Read the message too.
 */
const KEY_PROBLEM_RE = /api[ _-]?key|API_KEY_INVALID|PERMISSION_DENIED|not authorized|has not been used|is disabled|billing/i;

function placesErrorType(status, payload) {
  const detail = squish(payload?.error?.message);
  if (KEY_PROBLEM_RE.test(detail)) return 'auth';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'bad_request';
  return 'http_error';
}

/** Turn Google's error payload into something a user can act on. */
function describePlacesError(status, payload) {
  const detail = squish(payload?.error?.message) || `HTTP ${status}`;
  if (placesErrorType(status, payload) === 'auth') {
    return `Google refused the API key: ${detail} — check that the key is correct, that "Places API (New)" is enabled for the project, that billing is on, and that any key restrictions (HTTP referrer / IP) allow this server.`;
  }
  if (status === 429) {
    return `Google rate-limited or quota-capped the key: ${detail}`;
  }
  if (status === 400) {
    return `Google rejected the request: ${detail} — usually a field-mask or query problem.`;
  }
  return `Places API error: ${detail}`;
}

/**
 * Resolve photo resource names to usable image URLs.
 *
 * Each resolution is a separate billed request, so this is capped and only
 * runs for places that actually have photos. `skipHttpRedirect=true` is used
 * deliberately: the plain media URL would work in an <img> tag but only by
 * carrying the API key in a client-visible URL.
 */
export async function resolvePhotoUrls(photos, { apiKey, maxPhotos = 1, maxHeightPx = 800, timeoutMs = 10000, fetchImpl = fetch }) {
  const urls = [];
  for (const photo of (photos ?? []).slice(0, maxPhotos)) {
    if (!photo?.name) continue;
    const url = `${PHOTO_BASE}/${photo.name}/media?maxHeightPx=${maxHeightPx}&skipHttpRedirect=true&key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const body = await res.json().catch(() => ({}));
      if (body?.photoUri) urls.push(body.photoUri);
    } catch {
      // A photo that will not resolve is not worth failing the whole search.
    }
  }
  return urls;
}

/**
 * The public entry point: labels in, list-shaped result out.
 *
 * @param {object} input
 * @param {string} input.query          e.g. "beauty salons in Yangon"
 * @param {string[]} input.labels       the user's own field labels
 * @param {object} [input.options]
 * @returns {Promise<object>} the same result shape as scraper list mode
 */
export async function searchGooglePlaces({ query, labels, options = {} }) {
  const {
    apiKey = process.env.GOOGLE_MAPS_API_KEY,
    maxResults = PAGE_SIZE,
    maxPhotosPerPlace = 1,
    languageCode,
    regionCode,
    timeoutMs = 15000,
    fetchImpl = fetch,
  } = options;

  const specs = parseLabels(labels);
  const warnings = [];
  const errors = [];

  const cleanQuery = squish(query);
  if (!cleanQuery) {
    return emptyResult(specs, [{ type: 'no_query', message: 'A search query is required, for example "beauty salons in Yangon".' }], warnings);
  }
  if (!specs.length) {
    return emptyResult(specs, [{ type: 'no_labels', message: 'No labels were provided — nothing to return.' }], warnings);
  }
  if (!apiKey) {
    return emptyResult(specs, [{
      type: 'no_api_key',
      message: 'No Google API key. Set GOOGLE_MAPS_API_KEY on the server, with "Places API (New)" enabled for the project. This uses the official API rather than scraping Maps, so a key is required and Google bills your project for each search.',
    }], warnings);
  }

  const { assignments, fieldMask, unmatched, wantsPhotos } = mapLabelsToFields(specs);
  if (unmatched.length) {
    warnings.push(
      `Google Places has no field for: ${unmatched.join(', ')}. ` +
      'Those columns will be null. Places returns a fixed set of fields, unlike scraping a page.',
    );
  }
  if (!assignments.size) {
    return emptyResult(specs, [{
      type: 'no_mappable_labels',
      message: `None of these labels map to a Places field: ${specs.map((s) => s.label).join(', ')}. Try Name, Address, Phone Number, Website, Rating, Reviews, Opening Hours, Category, Latitude, Longitude or Photo.`,
    }], warnings);
  }

  const search = await searchPlaces({
    query: cleanQuery, apiKey, fieldMask, maxResults, languageCode, regionCode, timeoutMs, fetchImpl,
  });
  warnings.push(...search.warnings);
  errors.push(...search.errors);

  const records = [];
  for (const [index, place] of search.places.entries()) {
    /** @type {Record<string, any>} */
    const data = {};
    /** @type {Record<string, any>} */
    const fields = {};

    let photoUrls = null;
    if (wantsPhotos && Array.isArray(place.photos) && place.photos.length) {
      photoUrls = await resolvePhotoUrls(place.photos, {
        apiKey,
        maxPhotos: Math.max(1, maxPhotosPerPlace),
        fetchImpl,
        timeoutMs,
      });
    }

    for (const spec of specs) {
      const assigned = assignments.get(spec.key);
      let value = null;

      if (assigned) {
        if (assigned.field.photos) {
          const urls = photoUrls ?? [];
          value = spec.plural ? urls : urls[0] ?? null;
        } else {
          const raw = assigned.field.read(place);
          value = spec.plural && raw != null ? String(raw).split(/\s*[;,]\s*/).filter(Boolean) : raw;
        }
      } else if (spec.plural) {
        value = [];
      }

      const found = Array.isArray(value) ? value.length > 0 : value != null && value !== '';
      data[spec.key] = found ? value : spec.plural ? [] : null;
      fields[spec.key] = {
        label: spec.label,
        value: data[spec.key],
        source_url: place.googleMapsUri ?? 'https://places.googleapis.com/v1/places:searchText',
        method: assigned ? `places:${assigned.field.mask.split(',')[0]}` : null,
        selector: null,
        confidence: found ? 0.95 : 0,
        value_type: spec.type,
        found,
      };
    }

    if (!Object.values(fields).some((f) => f.found)) continue;
    records.push({ index, data, fields, source_url: place.googleMapsUri ?? null, fields_found: 0 });
  }

  const result = assembleListResult({
    url: `google-places:${cleanQuery}`,
    specs,
    records,
    pagesVisited: [{
      url: SEARCH_URL,
      final_url: SEARCH_URL,
      status: errors.length ? 0 : 200,
      renderer: 'google-places-api',
      reasons: [`text search: "${cleanQuery}"`],
      records_found: records.length,
      records_added: records.length,
    }],
    pagination: {
      enabled: true,
      pages_walked: search.calls,
      page_budget: Math.ceil(Math.min(maxResults, MAX_RESULTS) / PAGE_SIZE),
      scrolled: false,
      stopped_because: records.length >= MAX_RESULTS
        ? `Google's hard limit of ${MAX_RESULTS} results for a text search`
        : errors.length
          ? 'the Places API returned an error'
          : 'no further pages',
    },
    errors,
    warnings,
    options,
  });

  result.source = 'google-places';
  result.query = cleanQuery;
  result.api_calls = search.calls + (wantsPhotos ? records.length : 0);
  return result;
}

function emptyResult(specs, errors, warnings) {
  const result = assembleListResult({
    url: 'google-places:',
    specs,
    records: [],
    pagesVisited: [],
    errors,
    warnings,
    options: {},
  });
  result.source = 'google-places';
  return result;
}
