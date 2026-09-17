/**
 * List-record extraction: many records from one directory page.
 * The fixture mirrors a real Yellow-Pages-style card layout, including the
 * traps that make naive list scraping wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from '../tools/serve-fixture.mjs';
import { scrape } from '../src/core/pipeline.js';

const PORT = 8151;
const BASE = `http://localhost:${PORT}`;
const LIST_URL = `${BASE}/directory.html`;
const OPTS = { minDelayMs: 0, render: 'never', logLevel: 'silent' };
const LABELS = ['Name', 'Category', 'Address', 'Phone Number', 'Image'];

let server;
let listing;

test.before(async () => {
  server = await startFixtureServer(PORT);
  listing = await scrape({ url: LIST_URL, labels: LABELS, options: OPTS });
});

test.after(() => server?.close());

test('a directory page yields one record per listing', () => {
  assert.equal(listing.mode, 'list');
  assert.equal(listing.status, 'ok');
  assert.equal(listing.record_count, 4);
  assert.deepEqual(
    listing.records.map((r) => r.name),
    ['2 Lady', '808 Beauty Center', 'Abae', 'Beauty Bar Mandalay'],
  );
});

test('every requested field is filled per record, from that record', () => {
  const first = listing.records[0];
  assert.equal(first.name, '2 Lady');
  assert.equal(first.category, 'Beauty Salons and Spa');
  assert.equal(first.address, 'No.75, 12st, Lanmadaw.Tsp, Yangon');
  assert.equal(first.phone_number, '09-421116317');
  assert.equal(first.image, `${BASE}/images/company/2lady.jpg`);

  // Each record's address and phone are its own, not the previous row's.
  const addresses = new Set(listing.records.map((r) => r.address));
  const phones = new Set(listing.records.map((r) => r.phone_number));
  assert.equal(addresses.size, 4);
  assert.equal(phones.size, 4);
});

test('page-level metadata never leaks into records', () => {
  // These are the actual wrong answers the single-record cascade produced on a
  // listing page: the directory's own logo, title and footer address.
  for (const record of listing.records) {
    assert.ok(!/ypg-logo/.test(record.image ?? ''), `site logo leaked: ${record.image}`);
    assert.ok(!/Yellow Pages/i.test(record.name ?? ''), `site title leaked: ${record.name}`);
    assert.ok(!/sole authorised publisher/i.test(record.category ?? ''), `og:type leaked: ${record.category}`);
    assert.ok(!/31st/.test(record.address ?? ''), `footer address leaked: ${record.address}`);
    assert.ok(!/5141770/.test(record.phone_number ?? ''), `footer phone leaked: ${record.phone_number}`);
  }
});

test('images prefer the full-size lazy URL over the thumbnail', () => {
  for (const record of listing.records) {
    assert.ok(record.image, 'every card has an image');
    assert.ok(!/-thumb\./.test(record.image), `thumbnail returned: ${record.image}`);
    assert.match(record.image, /^http:\/\//, 'absolute URL');
  }
});

test('the advert slot in the repeating group is not a record', () => {
  assert.ok(
    !listing.records.some((r) => /banner-300x250/.test(r.image ?? '')),
    'advert image became a record',
  );
  // 5 siblings share the card signature; only 4 carry data.
  assert.equal(listing.record_count, 4);
});

test('the sidebar category list is not mistaken for the records', () => {
  assert.match(listing.list_container.selector, /results/);
  assert.ok(
    !listing.records.some((r) => /Ambulance Service|Perfumes/.test(r.name ?? '')),
    'sidebar links became records',
  );
});

test('coverage is reported per label', () => {
  for (const key of ['name', 'category', 'address', 'phone_number', 'image']) {
    assert.equal(listing.field_coverage[key].found_in, 4, key);
    assert.equal(listing.field_coverage[key].percent, 100, key);
  }
  assert.deepEqual(listing.missing_fields, []);
});

test('provenance is kept per record, parallel to the values', () => {
  assert.equal(listing.record_fields.length, listing.record_count);
  const f = listing.record_fields[0];
  assert.equal(f.phone_number.method, 'a[href^=tel:]');
  assert.equal(f.phone_number.source_url, LIST_URL);
  assert.ok(f.address.method, 'address says how it was found');
  assert.ok(f.image.confidence > 0);
});

test('auto mode still picks single-record extraction for a subject page', async () => {
  // The clinic homepage has no repeating structure that answers these labels.
  const result = await scrape({
    url: BASE,
    labels: ['Clinic Name', 'Phone Number'],
    options: OPTS,
  });
  assert.notEqual(result.mode, 'list');
  assert.equal(result.data.clinic_name, 'Blue Harbour Dental');
});

test('list mode on a non-list page reports that, rather than inventing rows', async () => {
  const result = await scrape({
    url: `${BASE}/about.html`,
    labels: ['Name', 'Phone Number'],
    options: { ...OPTS, mode: 'list' },
  });
  assert.equal(result.mode, 'list');
  assert.equal(result.record_count, 0);
  assert.deepEqual(result.records, []);
  assert.match(result.warnings.join(' '), /No repeating list structure/);
});

test('single mode can be forced on a listing page', async () => {
  const result = await scrape({
    url: LIST_URL,
    labels: ['Name'],
    options: { ...OPTS, mode: 'single', followInternalLinks: false },
  });
  assert.equal(result.mode, undefined, 'single-record results carry no list mode');
  assert.ok(result.data, 'single mode returns page-level data');
});

test('a list run does not wander off to other pages', () => {
  assert.equal(listing.pages_visited.length, 1);
  assert.equal(listing.pages_visited[0].records_found, 4);
});

test('list CSV is one row per record with a column per label', async () => {
  const { toCsv } = await import('../src/output/exporters.js');
  const csv = toCsv(listing);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 5, 'header + 4 records');
  assert.equal(lines[0], 'name,category,address,phone_number,image,source_url');
  assert.match(lines[1], /^2 Lady,Beauty Salons and Spa,"No\.75/);
  // A comma-bearing address must stay inside one quoted cell.
  assert.equal(lines[2].split('","').length, 1);
  assert.match(lines[2], /"310, Cor\. of Anawrahta[^"]*"/);
});
