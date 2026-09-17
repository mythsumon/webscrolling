/**
 * End-to-end pipeline tests against a local fixture site on 127.0.0.1.
 * They exercise fetching, robots.txt, internal-link discovery and result
 * assembly, and never touch the public internet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from '../tools/serve-fixture.mjs';
import { scrape } from '../src/core/pipeline.js';

const PORT = 8123;
const BASE = `http://localhost:${PORT}`;
const OPTS = { minDelayMs: 0, render: 'never', maxPages: 5, logLevel: 'silent' };

let server;

test.before(async () => {
  server = await startFixtureServer(PORT);
});

test.after(() => {
  server?.close();
});

test('follows only the relevant internal pages, and records why', async () => {
  const result = await scrape({
    url: `localhost:${PORT}`,
    labels: ['Clinic Name', 'Phone Number', 'Email', 'Address', 'Opening Hours', 'Gallery Images', 'Facebook'],
    options: OPTS,
  });

  assert.equal(result.status, 'ok', JSON.stringify(result.missing_fields));
  assert.equal(result.data.clinic_name, 'Blue Harbour Dental');
  assert.equal(result.data.phone_number, '+64 9 555 0142');
  assert.equal(result.data.email, 'hello@blueharbourdental.example');
  assert.match(result.data.address, /18 Quay Street/);
  assert.match(result.data.opening_hours, /Mon-Fri/);
  assert.equal(result.data.facebook, 'https://www.facebook.com/blueharbourdental');

  const visited = result.pages_visited.map((p) => p.url);
  assert.ok(visited.includes(`${BASE}/contact.html`), 'should follow /contact');
  assert.ok(visited.includes(`${BASE}/gallery.html`), 'should follow /gallery');
  // Budget is respected and no page is visited twice.
  assert.ok(visited.length <= 5, `visited ${visited.length} pages`);
  assert.equal(new Set(visited).size, visited.length);
  // Every followed page explains itself.
  for (const page of result.pages_visited) assert.ok(page.reasons.length > 0);
});

test('values carry the page they actually came from', async () => {
  const result = await scrape({
    url: BASE,
    labels: ['Phone Number', 'Clinic Name'],
    options: OPTS,
  });
  assert.equal(result.fields.phone_number.source_url, `${BASE}/contact.html`);
  assert.equal(result.fields.clinic_name.source_url, `${BASE}/`);
});

test('images are absolutised against the serving page and ranked by size', async () => {
  const result = await scrape({
    url: BASE,
    labels: ['Main Image', 'Gallery Images'],
    options: OPTS,
  });
  assert.equal(result.data.main_image, `${BASE}/img/clinic-hero.jpg`);
  const gallery = result.data.gallery_images;
  assert.ok(gallery.includes(`${BASE}/img/lab-1800.jpg`), 'largest srcset entry');
  assert.ok(!gallery.includes(`${BASE}/img/lab-600.jpg`), 'not the small variant too');
  assert.ok(!gallery.some((u) => /star\.svg/.test(u)), 'icons excluded');
  assert.ok(!gallery.some((u) => /^data:/.test(u)), 'placeholders excluded');
});

test('absent fields are null and listed, and the run is reported partial', async () => {
  const result = await scrape({
    url: BASE,
    labels: ['Clinic Name', 'Parking Fee', 'Helipad Capacity'],
    options: OPTS,
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.data.parking_fee, null);
  assert.equal(result.data.helipad_capacity, null);
  assert.deepEqual(result.missing_fields.sort(), ['Helipad Capacity', 'Parking Fee']);
  assert.equal(result.stats.labels_found, 1);
});

test('a bad URL fails cleanly instead of throwing', async () => {
  const result = await scrape({ url: 'not a url', labels: ['Name'], options: OPTS });
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0].type, 'invalid_url');
  assert.equal(result.data.name, null);
});

test('an unreachable host is reported, not thrown', async () => {
  const result = await scrape({
    url: 'http://localhost:9/',
    labels: ['Name'],
    options: { ...OPTS, requestTimeoutMs: 3000 },
  });
  assert.equal(result.status, 'error');
  assert.ok(result.errors.length > 0);
  assert.deepEqual(result.missing_fields, ['Name']);
});

test('robots.txt disallow is honoured', async () => {
  const result = await scrape({
    url: `${BASE}/admin/secret.html`,
    labels: ['Name'],
    options: OPTS,
  });
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0].type, 'robots_disallowed');
});

test('no labels is an error, not an empty success', async () => {
  const result = await scrape({ url: BASE, labels: [], options: OPTS });
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0].type, 'no_labels');
});

test('link following can be switched off', async () => {
  const result = await scrape({
    url: BASE,
    labels: ['Clinic Name', 'Phone Number'],
    options: { ...OPTS, followInternalLinks: false },
  });
  assert.equal(result.pages_visited.length, 1);
  assert.equal(result.data.phone_number, null, 'phone lives on /contact, which we did not visit');
  assert.deepEqual(result.missing_fields, ['Phone Number']);
});

test('a person label never answers with the business name', async () => {
  const result = await scrape({
    url: BASE,
    labels: ['Business Name', 'Practice Manager', 'CEO Name'],
    options: OPTS,
  });
  assert.equal(result.data.business_name, 'Blue Harbour Dental');
  // Labelled in the page as "Practice Manager: Ana Villareal".
  assert.equal(result.data.practice_manager, 'Ana Villareal');
  // No CEO is named anywhere, so the answer is null - not the company name,
  // not the h1, not the only person who happens to appear in prose.
  assert.equal(result.data.ceo_name, null);
  assert.ok(result.missing_fields.includes('CEO Name'));
});
