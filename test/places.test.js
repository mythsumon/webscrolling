/**
 * Google Places source. Every test stubs `fetchImpl`, so nothing here calls
 * Google — no key needed, no billing, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLabels } from '../src/extract/labels.js';
import {
  searchGooglePlaces, mapLabelsToFields, searchPlaces, resolvePhotoUrls, PAGE_SIZE, MAX_RESULTS,
} from '../src/sources/googlePlaces.js';

const KEY = 'test-key-not-real';

/** One place, shaped exactly as the Places API returns it. */
function place(n, extra = {}) {
  return {
    id: `place-${n}`,
    displayName: { text: `Salon ${n}` },
    formattedAddress: `No.${n}0, Example Road, Yangon, Myanmar`,
    nationalPhoneNumber: `09 421 00${n}`,
    internationalPhoneNumber: `+95 9 421 00${n}`,
    websiteUri: `https://salon${n}.example`,
    googleMapsUri: `https://maps.google.com/?cid=${n}`,
    rating: 4.5,
    userRatingCount: 120 + n,
    location: { latitude: 16.8 + n / 100, longitude: 96.1 + n / 100 },
    regularOpeningHours: { weekdayDescriptions: ['Monday: 9:00 AM – 6:00 PM', 'Tuesday: 9:00 AM – 6:00 PM'] },
    primaryTypeDisplayName: { text: 'Beauty salon' },
    types: ['beauty_salon', 'point_of_interest'],
    priceLevel: 'PRICE_LEVEL_MODERATE',
    businessStatus: 'OPERATIONAL',
    photos: [{ name: `places/place-${n}/photos/ref${n}` }],
    ...extra,
  };
}

/** A fetch stub that serves N places across pages, and photo lookups. */
function stubFetch({ total = 3, fail = null } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });

    if (String(url).includes('/media')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'x', photoUri: `https://lh3.googleusercontent.com/photo-${calls.length}` }),
      };
    }

    if (fail) {
      return { ok: false, status: fail.status, json: async () => ({ error: { message: fail.message } }) };
    }

    const body = JSON.parse(init.body);
    const offset = body.pageToken ? Number(body.pageToken) : 0;
    const size = Math.min(body.pageSize ?? PAGE_SIZE, total - offset);
    const batch = Array.from({ length: Math.max(0, size) }, (_, i) => place(offset + i + 1));
    const nextOffset = offset + batch.length;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        places: batch,
        ...(nextOffset < total ? { nextPageToken: String(nextOffset) } : {}),
      }),
    };
  };
  impl.calls = calls;
  return impl;
}

/* ------------------------------------------------- label -> field mapping */

test('labels map onto the Places fields that answer them', () => {
  const specs = parseLabels([
    'Name', 'Address', 'Phone Number', 'Website', 'Rating', 'Reviews',
    'Opening Hours', 'Category', 'Latitude', 'Longitude', 'Photo', 'Place ID',
  ]);
  const { assignments, unmatched, fieldMask, wantsPhotos } = mapLabelsToFields(specs);

  assert.deepEqual(unmatched, [], 'all of these should map');
  assert.equal(assignments.size, specs.length);
  assert.equal(wantsPhotos, true);

  // The mask is built from what was asked for — Google bills per field group.
  assert.match(fieldMask, /places\.displayName/);
  assert.match(fieldMask, /places\.formattedAddress/);
  assert.match(fieldMask, /places\.location/);
  assert.match(fieldMask, /nextPageToken/);
  assert.ok(!/places\.priceLevel/.test(fieldMask), 'price was not requested, so must not be billed for');
});

test('a label Places cannot answer is reported, not silently dropped', () => {
  const specs = parseLabels(['Name', 'Owner Email Address', 'Wheelchair Ramp Width']);
  const { unmatched, assignments } = mapLabelsToFields(specs);
  assert.ok(assignments.has('name'));
  assert.ok(unmatched.length >= 1, `expected unmatched labels, got ${JSON.stringify(unmatched)}`);
});

test('"International Phone" is not swallowed by the plain phone rule', () => {
  const specs = parseLabels(['International Phone']);
  const { assignments } = mapLabelsToFields(specs);
  const assigned = assignments.get(specs[0].key);
  assert.equal(assigned.field.key, 'phone_international');
});

/* ---------------------------------------------------------- the search */

test('a search returns one record per place, with the requested columns', async () => {
  const fetchImpl = stubFetch({ total: 3 });
  const result = await searchGooglePlaces({
    query: 'beauty salons in Yangon',
    labels: ['Name', 'Address', 'Phone Number', 'Rating', 'Opening Hours', 'Category'],
    options: { apiKey: KEY, fetchImpl },
  });

  assert.equal(result.mode, 'list');
  assert.equal(result.source, 'google-places');
  assert.equal(result.record_count, 3);

  const first = result.records[0];
  assert.equal(first.name, 'Salon 1');
  assert.equal(first.address, 'No.10, Example Road, Yangon, Myanmar');
  assert.equal(first.phone_number, '09 421 001');
  assert.equal(first.rating, '4.5');
  assert.match(first.opening_hours, /Monday: 9:00/);
  assert.equal(first.category, 'Beauty salon');
  assert.equal(result.status, 'ok');
});

test('the request is shaped the way the API requires', async () => {
  const fetchImpl = stubFetch({ total: 1 });
  await searchGooglePlaces({
    query: 'cafes in Mandalay',
    labels: ['Name'],
    options: { apiKey: KEY, fetchImpl, languageCode: 'en' },
  });

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://places.googleapis.com/v1/places:searchText');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['X-Goog-Api-Key'], KEY);
  assert.ok(call.init.headers['X-Goog-FieldMask'], 'a field mask is mandatory');
  const body = JSON.parse(call.init.body);
  assert.equal(body.textQuery, 'cafes in Mandalay');
  assert.equal(body.languageCode, 'en');
  assert.ok(body.pageSize <= PAGE_SIZE);
});

test('pagination follows nextPageToken up to the requested count', async () => {
  const fetchImpl = stubFetch({ total: 45 });
  const result = await searchGooglePlaces({
    query: 'salons',
    labels: ['Name'],
    options: { apiKey: KEY, fetchImpl, maxResults: 45 },
  });
  assert.equal(result.record_count, 45);
  assert.equal(result.records.at(-1).name, 'Salon 45');
  // 45 results at 20 per page is three requests.
  const searchCalls = fetchImpl.calls.filter((c) => !c.url.includes('/media'));
  assert.equal(searchCalls.length, 3);
});

test("Google's 60-result ceiling is enforced and explained", async () => {
  const fetchImpl = stubFetch({ total: 200 });
  const result = await searchGooglePlaces({
    query: 'salons',
    labels: ['Name'],
    options: { apiKey: KEY, fetchImpl, maxResults: 200 },
  });
  assert.equal(result.record_count, MAX_RESULTS);
  assert.match(result.warnings.join(' '), /at most 60 results/i);
});

test('photos are resolved to real URLs, not key-bearing media links', async () => {
  const fetchImpl = stubFetch({ total: 2 });
  const result = await searchGooglePlaces({
    query: 'salons',
    labels: ['Name', 'Photo'],
    options: { apiKey: KEY, fetchImpl },
  });

  for (const record of result.records) {
    assert.match(record.photo, /^https:\/\/lh3\.googleusercontent\.com\//);
    assert.ok(!record.photo.includes(KEY), 'the API key must never reach the client');
  }
  // skipHttpRedirect is what makes that possible.
  const photoCall = fetchImpl.calls.find((c) => c.url.includes('/media'));
  assert.match(photoCall.url, /skipHttpRedirect=true/);
  assert.match(photoCall.url, /maxHeightPx=\d+/);
});

test('a plural photo label returns an array', async () => {
  const fetchImpl = stubFetch({ total: 1 });
  const result = await searchGooglePlaces({
    query: 'salons',
    labels: ['Photos'],
    options: { apiKey: KEY, fetchImpl, maxPhotosPerPlace: 1 },
  });
  assert.ok(Array.isArray(result.records[0].photos));
  assert.equal(result.records[0].photos.length, 1);
});

/* ------------------------------------------------------- failure paths */

test('a missing API key is an actionable error, not a crash', async () => {
  const result = await searchGooglePlaces({
    query: 'salons',
    labels: ['Name'],
    options: { apiKey: undefined, fetchImpl: stubFetch() },
  });
  assert.equal(result.record_count, 0);
  assert.equal(result.errors[0].type, 'no_api_key');
  assert.match(result.errors[0].message, /GOOGLE_MAPS_API_KEY/);
});

test('a rejected key explains what to check', async () => {
  const fetchImpl = stubFetch({ fail: { status: 403, message: 'Places API has not been used in project' } });
  const result = await searchGooglePlaces({
    query: 'salons',
    labels: ['Name'],
    options: { apiKey: KEY, fetchImpl },
  });
  assert.equal(result.errors[0].type, 'auth');
  assert.match(result.errors[0].message, /Places API \(New\)/);
  assert.equal(result.record_count, 0);
});

test('quota exhaustion is reported as rate limiting', async () => {
  const fetchImpl = stubFetch({ fail: { status: 429, message: 'Quota exceeded' } });
  const result = await searchGooglePlaces({ query: 'x', labels: ['Name'], options: { apiKey: KEY, fetchImpl } });
  assert.equal(result.errors[0].type, 'rate_limited');
});

test('an empty query and empty labels each fail cleanly', async () => {
  const noQuery = await searchGooglePlaces({ query: '   ', labels: ['Name'], options: { apiKey: KEY } });
  assert.equal(noQuery.errors[0].type, 'no_query');
  const noLabels = await searchGooglePlaces({ query: 'x', labels: [], options: { apiKey: KEY } });
  assert.equal(noLabels.errors[0].type, 'no_labels');
});

test('a photo that will not resolve does not fail the search', async () => {
  const impl = async (url, init) => {
    if (String(url).includes('/media')) return { ok: false, status: 500, json: async () => ({}) };
    return stubFetch({ total: 1 })(url, init);
  };
  const urls = await resolvePhotoUrls([{ name: 'places/x/photos/y' }], { apiKey: KEY, fetchImpl: impl });
  assert.deepEqual(urls, []);
});

/* ------------------------------------------------------------- exports */

test('results export as CSV through the same path as scraped lists', async () => {
  const fetchImpl = stubFetch({ total: 2 });
  const result = await searchGooglePlaces({
    query: 'salons',
    labels: ['Name', 'Address', 'Rating'],
    options: { apiKey: KEY, fetchImpl },
  });
  const { toCsv } = await import('../src/output/exporters.js');
  const lines = toCsv(result).split('\r\n');
  assert.equal(lines[0], 'name,address,rating,source_url');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^Salon 1,"No\.10, Example Road, Yangon, Myanmar",4\.5/);
});

test('coverage is reported per column, as for scraped lists', async () => {
  const fetchImpl = stubFetch({ total: 2 });
  const result = await searchGooglePlaces({
    query: 'salons',
    labels: ['Name', 'Address'],
    options: { apiKey: KEY, fetchImpl },
  });
  assert.equal(result.field_coverage.name.percent, 100);
  assert.equal(result.field_coverage.address.found_in, 2);
});

test('a place missing a field yields null there, not a guess', async () => {
  const impl = async (url, init) => {
    if (String(url).includes('/media')) return { ok: true, status: 200, json: async () => ({ photoUri: 'https://x/y' }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ places: [place(1, { nationalPhoneNumber: undefined, internationalPhoneNumber: undefined, websiteUri: undefined })] }),
    };
  };
  const result = await searchGooglePlaces({
    query: 'salons',
    labels: ['Name', 'Phone Number', 'Website'],
    options: { apiKey: KEY, fetchImpl: impl },
  });
  assert.equal(result.records[0].name, 'Salon 1');
  assert.equal(result.records[0].phone_number, null);
  assert.equal(result.records[0].website, null);
  assert.equal(result.field_coverage.phone_number.found_in, 0);
  assert.equal(result.status, 'partial');
});

test('an invalid key is classified as an auth problem even though Google says 400', async () => {
  // Google returns 400 for API_KEY_INVALID, so classifying on status alone
  // would tell the user to go and check their field mask.
  const fetchImpl = stubFetch({ fail: { status: 400, message: 'API key not valid. Please pass a valid API key.' } });
  const result = await searchGooglePlaces({ query: 'x', labels: ['Name'], options: { apiKey: KEY, fetchImpl } });
  assert.equal(result.errors[0].type, 'auth');
  assert.match(result.errors[0].message, /Places API \(New\)/);
  assert.ok(!/field-mask/.test(result.errors[0].message), 'must not misdirect to the field mask');
});

test('a genuinely malformed request is still reported as a bad request', async () => {
  const fetchImpl = stubFetch({ fail: { status: 400, message: 'Invalid field mask: places.nope' } });
  const result = await searchGooglePlaces({ query: 'x', labels: ['Name'], options: { apiKey: KEY, fetchImpl } });
  assert.equal(result.errors[0].type, 'bad_request');
  assert.match(result.errors[0].message, /field-mask/);
});
