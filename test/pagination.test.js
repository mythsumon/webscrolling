/**
 * Getting every row off a paginated list — the two mechanisms:
 *   numbered pagination (`/paged?page=N`, served dynamically by the fixture)
 *   infinite scroll + "load more" (`/infinite.html`, needs a browser)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from '../tools/serve-fixture.mjs';
import { scrape } from '../src/core/pipeline.js';
import { parsePageNumber, discoverNextPage, hasPaginationControls } from '../src/links/discovery.js';
import { buildPageModel } from '../src/core/page.js';

const PORT = 8171;
const BASE = `http://localhost:${PORT}`;
const PAGED = `${BASE}/paged?page=1`;
const LABELS = ['Name', 'Category', 'Address', 'Phone Number'];
const OPTS = { minDelayMs: 0, render: 'never', logLevel: 'silent' };

let server;

test.before(async () => {
  server = await startFixtureServer(PORT);
});

test.after(() => server?.close());

/* ------------------------------------------------- page-number parsing */

test('page numbers are read from every common URL shape', () => {
  assert.equal(parsePageNumber('https://x.test/list?page=4').number, 4);
  assert.equal(parsePageNumber('https://x.test/list?paged=12&x=1').number, 12);
  assert.equal(parsePageNumber('https://x.test/list/page/7/').number, 7);
  assert.equal(parsePageNumber('https://x.test/list?p=3').number, 3);
  assert.equal(parsePageNumber('https://x.test/salons-page-9.html').number, 9);
  assert.equal(parsePageNumber('https://x.test/list?start=40').kind, 'offset');
  assert.equal(parsePageNumber('https://x.test/list'), null);
});

test('the next page is found even when the control has no text', () => {
  // This is the case that defeats text matching: an icon-only anchor.
  const html = `<html><body><main>
    <div class="pagination">
      <span class="page-numbers current">2</span>
      <a class="page-numbers" href="/list?page=3">3</a>
      <a class="pagination-next" href="/list?page=3"><span class="icon"></span></a>
    </div></main></body></html>`;
  const page = buildPageModel({ html, url: 'https://x.test/list?page=2', finalUrl: 'https://x.test/list?page=2' });
  const next = discoverNextPage(page, { visited: new Set(), rootUrl: 'https://x.test/list' });
  assert.ok(next, 'should find page 3');
  assert.match(next.url, /page=3$/);
  assert.match(next.reasons[0], /numbered pagination/);
});

test('a disabled next control on the last page is not followed', () => {
  const html = `<html><body><main>
    <div class="pagination">
      <a class="page-numbers" href="/list?page=2">2</a>
      <span class="page-numbers current">3</span>
      <a class="pagination-next disabled" href="/list?page=3">Next</a>
    </div></main></body></html>`;
  const page = buildPageModel({ html, url: 'https://x.test/list?page=3', finalUrl: 'https://x.test/list?page=3' });
  const next = discoverNextPage(page, { visited: new Set(['https://x.test/list?page=3']), rootUrl: 'https://x.test/list' });
  assert.equal(next, null, 'page 4 does not exist and the control is disabled');
  assert.ok(hasPaginationControls(page), 'but the page is recognisably paginated');
});

test('"previous" is never mistaken for "next"', () => {
  const html = `<html><body><main><div class="pagination">
    <a rel="prev" href="/list?page=1">« Previous</a>
  </div></main></body></html>`;
  const page = buildPageModel({ html, url: 'https://x.test/list?page=2', finalUrl: 'https://x.test/list?page=2' });
  // Page 3 is not linked, so there is nothing to follow.
  assert.equal(discoverNextPage(page, { visited: new Set(), rootUrl: 'https://x.test/list' }), null);
});

/* --------------------------------------------------- walking the pages */

test('without pagination only the first page is read, and it says so', async () => {
  const result = await scrape({ url: PAGED, labels: LABELS, options: OPTS });
  assert.equal(result.record_count, 3);
  assert.equal(result.pagination.pages_walked, 1);
  assert.match(result.pagination.stopped_because, /pagination following is off/);
});

test('allowPagination walks the default budget of extra pages', async () => {
  const result = await scrape({
    url: PAGED,
    labels: LABELS,
    options: { ...OPTS, allowPagination: true, maxPaginationPages: 1 },
  });
  assert.equal(result.pagination.pages_walked, 2);
  assert.equal(result.record_count, 6);
  assert.match(result.pagination.stopped_because, /page budget/);
});

test('maxPaginationPages "all" collects every page and stops at the end', async () => {
  const result = await scrape({
    url: PAGED,
    labels: LABELS,
    options: { ...OPTS, allowPagination: true, maxPaginationPages: 'all' },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.pagination.pages_walked, 3);
  assert.equal(result.record_count, 9);
  assert.deepEqual(
    result.records.map((r) => r.name),
    ['Salon 01', 'Salon 02', 'Salon 03', 'Salon 04', 'Salon 05',
      'Salon 06', 'Salon 07', 'Salon 08', 'Salon 09'],
  );
  assert.match(result.pagination.stopped_because, /last page/);

  // Records stay attributed to the page they came from.
  assert.match(result.records[0]._source_url, /page=1/);
  assert.match(result.records[8]._source_url, /page=3/);
  assert.equal(result.pages_visited.length, 3);
  for (const page of result.pages_visited) assert.equal(page.records_added, 3);
});

test('maxRecords stops the walk mid-way and reports why', async () => {
  const result = await scrape({
    url: PAGED,
    labels: LABELS,
    options: { ...OPTS, allowPagination: true, maxPaginationPages: 'all', maxRecords: 4 },
  });
  assert.equal(result.record_count, 4);
  assert.match(result.pagination.stopped_because, /record cap/);
  assert.ok(result.pagination.pages_walked <= 2);
});

test('no row is collected twice across pages', async () => {
  const result = await scrape({
    url: PAGED,
    labels: LABELS,
    options: { ...OPTS, allowPagination: true, maxPaginationPages: 'all' },
  });
  const names = result.records.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
});

test('every field is still per-record after a multi-page walk', async () => {
  const result = await scrape({
    url: PAGED,
    labels: LABELS,
    options: { ...OPTS, allowPagination: true, maxPaginationPages: 'all' },
  });
  for (const key of ['name', 'category', 'address', 'phone_number']) {
    assert.equal(result.field_coverage[key].percent, 100, key);
  }
  // Page 3's rows carry page 3's phone numbers, not page 1's.
  assert.equal(result.records[6].phone_number, '09-421000007');
  assert.equal(result.records[6].address, 'No.70, Example Road, Township 7, Yangon');
});

/* --------------------------------------------------- infinite scroll */

test('infinite scroll needs a browser: static HTML has only the first batch', async () => {
  const result = await scrape({
    url: `${BASE}/infinite.html`,
    labels: ['Name', 'Address', 'Phone Number'],
    options: OPTS,
  });
  assert.equal(result.record_count, 3);
});

test('exhaustScroll collects scroll-loaded and button-loaded rows', async (t) => {
  const result = await scrape({
    url: `${BASE}/infinite.html`,
    labels: ['Name', 'Address', 'Phone Number'],
    options: {
      minDelayMs: 0,
      render: 'auto',
      exhaustScroll: true,
      maxLoadMoreClicks: 5,
      scrollBudgetMs: 30000,
      logLevel: 'silent',
    },
  });

  if (result.pages_visited[0]?.renderer !== 'playwright') {
    t.skip('Playwright browser unavailable in this environment');
    return;
  }

  // 3 server-rendered + 6 revealed by scrolling + 3 behind "Load more".
  assert.equal(result.record_count, 12);
  assert.equal(result.records.at(-1).name, 'Studio 12');
  assert.equal(result.pagination.scrolled, true);
  assert.match(result.warnings.join(' '), /exhaustive scroll: \d+ scroll round/);
  assert.match(result.warnings.join(' '), /"load more" click/);
});
