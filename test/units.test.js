import test from 'node:test';
import assert from 'node:assert/strict';

import { validateUrl, normalizeUrl, imageIdentity, sameSite, looksNonHtml, absolutize } from '../src/util/url.js';
import { bestFromSrcset, dedupeImages } from '../src/extract/images.js';
import {
  validatePhone, normalizePhone, canonicalPhone, validateEmail, validatePrice, validateAddress,
  isSocialProfile, extractGeoFromUrl, validateLatitude,
} from '../src/extract/patterns.js';
import { verifyGrounding } from '../src/extract/llm.js';
import { toCsv } from '../src/output/exporters.js';
import { needsRendering } from '../src/core/renderer.js';
import * as cheerio from 'cheerio';

test('URL validation accepts bare hosts and rejects nonsense', () => {
  assert.equal(validateUrl('example-hotel.com').url, 'https://example-hotel.com/');
  assert.equal(validateUrl('https://a.com/x?b=1#frag').url, 'https://a.com/x?b=1');
  assert.equal(validateUrl('').ok, false);
  assert.equal(validateUrl('ftp://a.com').ok, false);
  assert.equal(validateUrl('not a url').ok, false);
  assert.equal(validateUrl('javascript:alert(1)').ok, false);
});

test('URL normalisation collapses the things that make duplicate visits', () => {
  const a = normalizeUrl('https://WWW.Example.com/Page/?utm_source=x&b=2&a=1#frag');
  const b = normalizeUrl('https://example.com/Page?a=1&b=2');
  assert.equal(a, b);
});

test('image identity collapses CDN size variants', () => {
  const variants = [
    'https://cdn.x.com/photo.jpg?w=400&quality=80',
    'https://cdn.x.com/photo.jpg?w=1600',
    'https://cdn.x.com/photo.jpg',
  ];
  const ids = new Set(variants.map(imageIdentity));
  assert.equal(ids.size, 1, [...ids].join(' | '));
  // Different images must not collapse.
  assert.notEqual(imageIdentity('https://cdn.x.com/a.jpg'), imageIdentity('https://cdn.x.com/b.jpg'));
});

test('srcset parsing picks the largest descriptor', () => {
  assert.equal(
    bestFromSrcset('a-480.jpg 480w, a-1200.jpg 1200w, a-800.jpg 800w').url,
    'a-1200.jpg',
  );
  assert.equal(bestFromSrcset('a.jpg 1x, a@2x.jpg 2x').url, 'a@2x.jpg');
  assert.equal(bestFromSrcset('single.jpg').url, 'single.jpg');
  assert.equal(bestFromSrcset(''), null);
});

test('dedupe keeps the higher-quality variant of one image', () => {
  const out = dedupeImages([
    { url: 'https://c.com/p.jpg?w=300', order: 1, trust: 0.7, width: 300, context: '', channel: 'img[src]' },
    { url: 'https://c.com/p.jpg?w=1600', order: 2, trust: 0.7, width: 1600, context: '', channel: 'img[srcset]' },
  ]);
  assert.equal(out.length, 1);
  assert.match(out[0].url, /w=1600/);
});

test('phone validation separates phones from look-alikes', () => {
  assert.ok(validatePhone('+95 9 7712 3456'));
  assert.ok(validatePhone('(01) 555 0142'));
  assert.ok(!validatePhone('2024-01-15'), 'ISO date');
  assert.ok(!validatePhone('12/03/2025'), 'slashed date');
  assert.ok(!validatePhone('USD 1,250.00'), 'price');
  assert.ok(!validatePhone('12345'), 'too short');
  assert.ok(!validatePhone('1234567890123456789'), 'too long');
  assert.ok(!validatePhone('0000000'), 'placeholder');
  assert.ok(!validatePhone('012345678'), 'sequential placeholder');
  assert.ok(!validatePhone('1234567890123', { context: 'company registration' }), 'bare id');
  // Display form keeps the grouping a human reads; canonical form is for dedupe.
  assert.equal(normalizePhone('+95 (9) 7712-3456'), '+95 (9) 7712-3456');
  assert.equal(normalizePhone('09 - 421116317'), '09-421116317');
  assert.equal(canonicalPhone('+95 (9) 7712-3456'), '+95977123456');
  assert.equal(canonicalPhone('0095 9 7712 3456'), '+95977123456');
  assert.equal(canonicalPhone('09-421116317'), '09421116317');
});

test('email validation rejects placeholders and image filenames', () => {
  assert.ok(validateEmail('stay@shwepyi.example'));
  assert.ok(!validateEmail('someone@example.com'));
  assert.ok(!validateEmail('logo@2x.png'));
  assert.ok(!validateEmail('not-an-email'));
  assert.ok(!validateEmail('abc@sentry.io'));
});

test('price validation needs a currency or a currency-shaped number', () => {
  assert.ok(validatePrice('USD 75'));
  assert.ok(validatePrice('$75.00 per night'));
  assert.ok(validatePrice('75'));
  assert.ok(!validatePrice('2026'), 'a year is not a price');
  assert.ok(!validatePrice('call for pricing'));
});

test('address validation rejects nav dumps and cookie text', () => {
  assert.ok(validateAddress('12 Moat Road, Chan Aye Thar Zan, Mandalay 05041'));
  assert.ok(!validateAddress('Home | Rooms | Gallery | Contact | Book'));
  assert.ok(!validateAddress('We use cookies on this website. Privacy policy applies to 1 visit.'));
  assert.ok(!validateAddress('Mandalay'), 'a bare city name is not an address');
});

test('social profile detection ignores share and intent links', () => {
  assert.ok(isSocialProfile('https://www.facebook.com/shwepyihotel', 'facebook'));
  assert.ok(!isSocialProfile('https://www.facebook.com/sharer/sharer.php?u=x', 'facebook'));
  assert.ok(!isSocialProfile('https://twitter.com/intent/tweet?url=x', 'twitter'));
  assert.ok(!isSocialProfile('https://www.facebook.com/', 'facebook'));
  assert.ok(!isSocialProfile('https://www.instagram.com/x', 'facebook'));
});

test('coordinates are parsed out of map URLs', () => {
  assert.deepEqual(
    extractGeoFromUrl('https://www.google.com/maps/embed?pb=!1m18!3d21.9588!4d96.0891'),
    { latitude: '21.9588', longitude: '96.0891' },
  );
  assert.deepEqual(
    extractGeoFromUrl('https://maps.google.com/?q=21.9588,96.0891'),
    { latitude: '21.9588', longitude: '96.0891' },
  );
  assert.equal(extractGeoFromUrl('https://example.com/page'), null);
  assert.ok(!validateLatitude('195.5'), 'out of range');
});

test('link helpers behave', () => {
  assert.equal(absolutize('/rooms', 'https://a.com/x/'), 'https://a.com/rooms');
  assert.equal(absolutize('mailto:x@y.com', 'https://a.com'), null);
  assert.ok(sameSite('https://www.a.com/x', 'https://a.com/y'));
  assert.ok(!sameSite('https://a.com', 'https://b.com'));
  assert.ok(looksNonHtml('https://a.com/file.pdf'));
  assert.ok(!looksNonHtml('https://a.com/contact'));
});

test('LLM grounding rejects values that are not in the page extract', () => {
  const haystack = 'Call us on +95 9 7712 3456 or email stay@shwepyi.example today.';
  assert.ok(verifyGrounding({ value: '+95 9 7712 3456', haystack }).ok);
  assert.ok(verifyGrounding({ value: '+959 7712 3456', haystack }).ok, 'whitespace differences tolerated');
  assert.ok(!verifyGrounding({ value: '+95 1 999 8888', haystack }).ok, 'invented number rejected');
  assert.ok(!verifyGrounding({ value: '', haystack }).ok);
});

test('render heuristic fires on an empty SPA shell but not on a real page', () => {
  const spa = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>';
  const $spa = cheerio.load(spa);
  assert.equal(needsRendering({ html: spa, text: '', $: $spa }).needed, true);

  const filler = 'Real content about the hotel and its rooms. '.repeat(40);
  const real = `<html><body><main><h1>Hotel</h1><p>${filler}</p></main></body></html>`;
  const $real = cheerio.load(real);
  assert.equal(needsRendering({ html: real, text: filler, $: $real }).needed, false);

  // Data-driven trigger: nothing found in the static HTML.
  assert.equal(
    needsRendering({ html: real, text: filler, $: $real }, { requiredFieldsUnresolved: true }).needed,
    true,
  );
});

test('CSV export escapes quotes, joins lists, and neutralises formulas', () => {
  const csv = toCsv({
    url: 'https://a.com',
    fields: {
      name: { label: 'Name', value: 'A "quoted", comma', value_type: 'name', source_url: 'https://a.com', method: 'jsonld', confidence: 0.95, found: true },
      gallery_images: { label: 'Gallery Images', value: ['https://a.com/1.jpg', 'https://a.com/2.jpg'], value_type: 'image_list', source_url: 'https://a.com', method: 'img', confidence: 0.8, found: true },
      formula: { label: 'Formula', value: '=SUM(A1:A2)', value_type: 'text', source_url: '', method: '', confidence: 0.5, found: true },
      missing: { label: 'Missing', value: null, value_type: 'text', source_url: null, method: null, confidence: 0, found: false },
    },
  });
  const lines = csv.split('\r\n');
  assert.match(lines[0], /^label,field_key,value/);
  assert.ok(lines[1].includes('"A ""quoted"", comma"'));
  assert.ok(lines[2].includes('https://a.com/1.jpg | https://a.com/2.jpg'));
  assert.ok(lines[3].includes("'=SUM(A1:A2)"), 'formula prefixed with an apostrophe');
  assert.ok(lines[4].endsWith(',text,,,0,no'), `missing-field row was: ${lines[4]}`);
});
