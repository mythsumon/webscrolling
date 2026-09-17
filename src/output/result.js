/**
 * Result assembly: candidates -> the JSON contract in ARCHITECTURE.md §5.
 *
 * This is where "never guess" is enforced for the last time: a field whose
 * best candidate is below `minConfidence` becomes null, and lands in
 * `missing_fields`.
 */

import { identityKey } from '../extract/patterns.js';

/**
 * @param {object} args
 * @param {string} args.url
 * @param {import('../extract/labels.js').FieldSpec[]} args.specs
 * @param {Record<string, object[]>} args.candidates   key -> candidates from all pages
 * @param {Array<object>} args.pagesVisited
 * @param {Array<object>} args.errors
 * @param {string[]} args.warnings
 * @param {object} args.options
 */
export function assembleResult({
  url, specs, candidates, pagesVisited, errors = [], warnings = [], options = {},
}) {
  const minConfidence = options.minConfidence ?? 0.4;
  const maxListItems = options.maxListItems ?? 40;

  /** @type {Record<string, any>} */
  const data = {};
  /** @type {Record<string, any>} */
  const fields = {};
  const missing = [];

  for (const spec of specs) {
    const pool = (candidates[spec.key] ?? [])
      .filter((c) => c.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence || (a.order ?? 0) - (b.order ?? 0));

    if (!pool.length) {
      data[spec.key] = spec.plural ? [] : null;
      fields[spec.key] = {
        label: spec.label,
        value: spec.plural ? [] : null,
        source_url: null,
        method: null,
        selector: null,
        confidence: 0,
        value_type: spec.type,
        found: false,
      };
      missing.push(spec.label);
      continue;
    }

    if (spec.plural) {
      const seen = new Set();
      const items = [];
      const sources = new Set();
      // Document order within a confidence tier reads better for galleries and
      // amenity lists than strict confidence order.
      const ordered = [...pool].sort(
        (a, b) =>
          Math.round(b.confidence * 10) - Math.round(a.confidence * 10) ||
          (a.order ?? 0) - (b.order ?? 0),
      );
      for (const c of ordered) {
        const id = identityKey(spec.type, c.value);
        if (seen.has(id)) continue;
        seen.add(id);
        items.push(c.value);
        if (c.sourceUrl) sources.add(c.sourceUrl);
        if (items.length >= maxListItems) break;
      }
      data[spec.key] = items;
      fields[spec.key] = {
        label: spec.label,
        value: items,
        source_url: pool[0].sourceUrl ?? null,
        source_urls: [...sources],
        method: pool[0].method,
        selector: pool[0].selector ?? null,
        confidence: round(pool[0].confidence),
        value_type: spec.type,
        found: items.length > 0,
        candidate_count: pool.length,
      };
      if (!items.length) missing.push(spec.label);
      continue;
    }

    const best = pool[0];
    data[spec.key] = best.value;
    fields[spec.key] = {
      label: spec.label,
      value: best.value,
      source_url: best.sourceUrl ?? null,
      method: best.method,
      selector: best.selector ?? null,
      confidence: round(best.confidence),
      value_type: spec.type,
      found: true,
      ...(best.snippet ? { snippet: best.snippet } : {}),
      // Runners-up are genuinely useful when a value looks wrong.
      alternatives: pool.slice(1, 4).map((c) => ({
        value: c.value,
        confidence: round(c.confidence),
        method: c.method,
        source_url: c.sourceUrl ?? null,
      })),
    };
  }

  const foundCount = specs.length - missing.length;
  let status;
  if (!pagesVisited.length || (!foundCount && errors.length)) status = 'error';
  else if (missing.length === 0) status = 'ok';
  else if (foundCount === 0) status = 'partial';
  else status = 'partial';

  return {
    url,
    status,
    fetched_at: new Date().toISOString(),
    data,
    fields,
    missing_fields: missing,
    pages_visited: pagesVisited,
    errors,
    warnings: [...new Set(warnings)],
    stats: {
      labels_requested: specs.length,
      labels_found: foundCount,
      pages_fetched: pagesVisited.length,
    },
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Result for a listing page: one record per list item.
 *
 * Deliberately does not carry a page-level `data` object. On a directory page
 * the page-level values are the site's own logo, title and footer address —
 * reporting them beside the records is how a caller ends up treating the site
 * logo as a business's photo.
 */
export function assembleListResult({
  url, specs, records, pagesVisited, group = null, pagination = null, errors = [], warnings = [], options = {},
}) {
  const requested = specs.map((s) => s.label);

  // A label is "missing" for the list as a whole only when no record resolved
  // it — one listing lacking a phone number is normal, none having one is not.
  const missing = specs
    .filter((spec) => !records.some((r) => r.fields[spec.key]?.found))
    .map((spec) => spec.label);

  const coverage = {};
  for (const spec of specs) {
    const found = records.filter((r) => r.fields[spec.key]?.found).length;
    coverage[spec.key] = {
      label: spec.label,
      found_in: found,
      of: records.length,
      percent: records.length ? Math.round((found / records.length) * 100) : 0,
    };
  }

  let status;
  if (!records.length) status = pagesVisited.length ? 'partial' : 'error';
  else if (!missing.length) status = 'ok';
  else status = 'partial';

  return {
    url,
    mode: 'list',
    status,
    fetched_at: new Date().toISOString(),
    record_count: records.length,
    records: records.map((r) => ({
      ...r.data,
      _source_url: r.source_url,
    })),
    // Provenance kept parallel rather than interleaved, so `records` stays a
    // clean array of plain objects that downstream code can use directly.
    record_fields: records.map((r) => r.fields),
    labels: requested,
    field_coverage: coverage,
    missing_fields: missing,
    list_container: group
      ? { selector: group.parentSelector, item_signature: group.signature, items_detected: group.count }
      : null,
    pagination,
    pages_visited: pagesVisited,
    errors,
    warnings: [...new Set(warnings)],
    stats: {
      labels_requested: specs.length,
      records_found: records.length,
      pages_fetched: pagesVisited.length,
    },
  };
}

/** An error result for failures before any page was parsed. */
export function errorResult({ url, specs, error, warnings = [], pagesVisited = [] }) {
  const data = {};
  const fields = {};
  for (const spec of specs) {
    data[spec.key] = spec.plural ? [] : null;
    fields[spec.key] = {
      label: spec.label,
      value: spec.plural ? [] : null,
      source_url: null,
      method: null,
      selector: null,
      confidence: 0,
      value_type: spec.type,
      found: false,
    };
  }
  return {
    url,
    status: 'error',
    fetched_at: new Date().toISOString(),
    data,
    fields,
    missing_fields: specs.map((s) => s.label),
    pages_visited: pagesVisited,
    errors: Array.isArray(error) ? error : [error],
    warnings,
    stats: { labels_requested: specs.length, labels_found: 0, pages_fetched: pagesVisited.length },
  };
}
