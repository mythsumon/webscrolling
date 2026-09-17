/**
 * End-to-end extraction against the local fixture — no network involved.
 * These are the tests that would catch a regression in the cascade.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPageModel } from '../src/core/page.js';
import { resolveField } from '../src/extract/resolvers.js';
import { parseLabel } from '../src/extract/labels.js';
import { assembleResult } from '../src/output/result.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_URL = 'https://shwepyi.example/';

let page;

test.before(async () => {
  const html = await readFile(path.join(here, 'fixtures', 'hotel.html'), 'utf8');
  page = buildPageModel({ html, url: FIXTURE_URL, finalUrl: FIXTURE_URL });
});

/** Best value for a label, or null. */
function best(label) {
  const spec = parseLabel(label);
  const candidates = resolveField(page, spec);
  return candidates.length ? candidates[0] : null;
}

function values(label, limit = 20) {
  const spec = parseLabel(label);
  return resolveField(page, spec).slice(0, limit).map((c) => c.value);
}

test('structured data wins for the obvious fields', () => {
  assert.equal(best('Hotel Name').value, 'Shwe Pyi Hotel');
  assert.match(best('Hotel Name').method, /jsonld/);

  assert.equal(best('Email').value, 'stay@shwepyi.example');
  assert.match(best('Address').value, /12 Moat Road/);
  assert.equal(best('Latitude').value, '21.9588');
  assert.equal(best('Longitude').value, '96.0891');
  assert.match(best('Description').value, /boutique hotel/i);
});

test('phone keeps its printed formatting, and is not the WhatsApp number', () => {
  const phone = best('Phone Number');
  // The tel: href is `tel:+959771234 56`; the printed number is the better
  // answer because the href has lost the national grouping.
  assert.equal(phone.value, '+95 9 7712 3456');
  assert.ok(phone.confidence >= 0.8, `confidence ${phone.confidence}`);
});

test('a narrow label takes the narrow value', () => {
  const wa = best('WhatsApp');
  assert.ok(wa, 'WhatsApp number should be found from the <dl>');
  assert.equal(wa.value, '+95 9 4455 6677');
});

test('price comes from the offer, not from the registration number', () => {
  const price = best('Price');
  assert.ok(price, 'price should be found');
  assert.match(price.value, /75/);
  assert.ok(!/1234567890123/.test(price.value), 'must not grab the company registration number');
});

test('phone validation rejects the long registration number in the footer', () => {
  const all = values('Phone Number', 50);
  assert.ok(!all.some((v) => v.includes('1234567890123')), `got ${all.join(', ')}`);
});

test('main image prefers og:image and returns an absolute URL', () => {
  const main = best('Main Image');
  assert.match(main.value, /^https:\/\/cdn\.shwepyi\.example\/hero-facade\.jpg/);
});

test('gallery images are absolute, deduped, and exclude icons and trackers', () => {
  const gallery = values('Gallery Images', 40);
  assert.ok(gallery.length >= 3, `expected several gallery images, got ${gallery.length}`);
  for (const url of gallery) {
    assert.match(url, /^https:\/\//, `${url} should be absolute`);
  }
  assert.ok(!gallery.some((u) => /pixel\.gif/.test(u)), 'tracking pixel must be filtered');
  assert.ok(!gallery.some((u) => /arrow-right/.test(u)), 'icon must be filtered');
  assert.ok(!gallery.some((u) => /^data:/.test(u)), 'placeholder data URI must be filtered');

  // Deduped by identity: the ?w=400 and ?w=1600 hero variants collapse.
  const heroVariants = gallery.filter((u) => u.includes('hero-facade'));
  assert.ok(heroVariants.length <= 1, `hero appears ${heroVariants.length} times`);
});

test('the largest srcset candidate is preferred', () => {
  const gallery = values('Gallery Images', 40).join(' ');
  assert.ok(gallery.includes('lobby-2000.jpg'), 'should take the 2000w lobby image');
  assert.ok(!gallery.includes('lobby-600.jpg'), 'should not also keep the 600w variant');
});

test('lazy-loaded images are picked up from data-src', () => {
  const gallery = values('Gallery Images', 40).join(' ');
  assert.ok(/gallery\/room-1/.test(gallery), 'data-src / lightbox href image should be found');
});

test('a narrow image label targets the right picture', () => {
  const menu = best('Menu Image');
  assert.match(menu.value, /menu-board\.jpg/);
});

test('amenities come back as a deduped list', () => {
  const amenities = values('Amenities', 20);
  assert.ok(amenities.includes('Free WiFi'));
  assert.ok(amenities.includes('Rooftop pool'));
  assert.ok(amenities.length >= 3);
});

test('room types come from the room list', () => {
  const rooms = values('Room Type', 20);
  assert.ok(rooms.some((r) => /Moat View Deluxe/.test(r)), rooms.join(' | '));
});

test('social profiles are distinguished from share links', () => {
  assert.equal(best('Facebook').value, 'https://www.facebook.com/shwepyihotel');
  assert.equal(best('Instagram').value, 'https://www.instagram.com/shwepyihotel');
  // The only twitter URL on the page is a share intent, which is not a profile.
  assert.equal(best('Twitter'), null);
});

test('opening hours are readable', () => {
  const hours = best('Opening Hours');
  assert.ok(hours, 'opening hours should be found');
  assert.match(hours.value, /Monday|Daily|\d{2}:\d{2}/);
});

test('a field that is genuinely absent resolves to null, not a guess', () => {
  // Nothing on the fixture is about pets, and no structured-data key comes
  // close, so every tier must decline rather than offer nearby text.
  const spec = parseLabel('Pet Policy');
  const found = resolveField(page, spec).filter((c) => c.confidence >= 0.4);
  const result = assembleResult({
    url: FIXTURE_URL,
    specs: [spec],
    candidates: { [spec.key]: found },
    pagesVisited: [{ url: FIXTURE_URL, status: 200, renderer: 'static' }],
  });
  assert.equal(result.data.pet_policy, null);
  assert.deepEqual(result.missing_fields, ["Pet Policy"]);
  assert.equal(result.status, 'partial');
});

test('every value carries provenance', () => {
  const specs = ['Hotel Name', 'Phone Number', 'Main Image'].map(parseLabel);
  const candidates = {};
  for (const spec of specs) candidates[spec.key] = resolveField(page, spec);
  const result = assembleResult({
    url: FIXTURE_URL,
    specs,
    candidates,
    pagesVisited: [{ url: FIXTURE_URL, status: 200, renderer: 'static' }],
  });
  assert.equal(result.status, 'ok');
  for (const field of Object.values(result.fields)) {
    assert.equal(field.source_url, FIXTURE_URL);
    assert.ok(field.method, 'method should say where the value came from');
    assert.ok(field.confidence > 0);
  }
  // The brief's flat shape is present alongside the provenance view.
  assert.equal(result.data.hotel_name, 'Shwe Pyi Hotel');
});

test('a list label does not absorb the page subject or other entities', () => {
  // "Room Type" must not return the hotel's own name, nor the amenity names,
  // just because Schema.org spells all of them `name`.
  const rooms = values('Room Type', 20);
  assert.ok(!rooms.includes('Shwe Pyi Hotel'), `hotel name leaked in: ${rooms.join(' | ')}`);
  assert.ok(!rooms.includes('Free WiFi'), `amenity leaked in: ${rooms.join(' | ')}`);
  assert.ok(rooms.some((r) => /Deluxe|Suite|Double/.test(r)), rooms.join(' | '));
});
