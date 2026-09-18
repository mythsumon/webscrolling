/** UI logic: label chips, scrape request, results table, exports. */

const form = document.getElementById('scrape-form');
const urlInput = document.getElementById('url');
const labelInput = document.getElementById('label-input');
const addLabelBtn = document.getElementById('add-label');
const labelList = document.getElementById('label-list');
const submitBtn = document.getElementById('submit');
const statusLine = document.getElementById('status-line');
const results = document.getElementById('results');
const resultsSummary = document.getElementById('results-summary');
const tbody = document.querySelector('#results-table tbody');
const thead = document.querySelector('#results-table thead');
const notices = document.getElementById('notices');
const pagesList = document.getElementById('pages-list');
const rawJson = document.getElementById('raw-json');
const toggleRaw = document.getElementById('toggle-raw');
const llmHint = document.getElementById('llm-hint');

const PRESETS = {
  hotel: ['Hotel Name', 'Address', 'Phone Number', 'Email', 'Website', 'Description',
    'Room Type', 'Price', 'Amenities', 'Main Image', 'Gallery Images'],
  business: ['Business Name', 'Address', 'Phone Number', 'Email', 'Opening Hours',
    'Facebook', 'Instagram', 'Latitude', 'Longitude', 'Main Image'],
  product: ['Product Name', 'Product Price', 'Description', 'SKU', 'Availability',
    'Main Image', 'Gallery Images'],
};

/** @type {string[]} */
let labels = [];
/** @type {Map<string, object>} label -> spec preview from the server */
let specPreview = new Map();
let lastResult = null;

/* ------------------------------------------------------------- labels UI */

function renderLabels() {
  labelList.replaceChildren();
  for (const label of labels) {
    const spec = specPreview.get(label);
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.textContent = label;
    li.append(name);

    if (spec) {
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = spec.plural ? `${spec.type} · list` : spec.type;
      kind.title = `Will be looked up as a ${spec.type}${spec.plural ? ' list' : ''} and returned as "${spec.key}"`;
      li.append(kind);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${label}`);
    remove.addEventListener('click', () => {
      labels = labels.filter((l) => l !== label);
      renderLabels();
      refreshPreview();
    });
    li.append(remove);

    labelList.append(li);
  }
}

function addLabels(input) {
  // Accept comma- or newline-separated paste as several labels.
  const parts = String(input).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  let added = 0;
  for (const part of parts) {
    if (labels.some((l) => l.toLowerCase() === part.toLowerCase())) continue;
    labels.push(part);
    added += 1;
  }
  if (added) {
    renderLabels();
    refreshPreview();
  }
  return added;
}

let previewTimer = null;
function refreshPreview() {
  clearTimeout(previewTimer);
  if (!labels.length) {
    specPreview = new Map();
    return;
  }
  previewTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/labels/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels }),
      });
      if (!res.ok) return;
      const { specs } = await res.json();
      specPreview = new Map(specs.map((s) => [s.label, s]));
      renderLabels();
    } catch {
      /* preview is a nicety; ignore failures */
    }
  }, 200);
}

addLabelBtn.addEventListener('click', () => {
  if (addLabels(labelInput.value)) labelInput.value = '';
  labelInput.focus();
});

labelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    if (addLabels(labelInput.value)) labelInput.value = '';
  } else if (e.key === 'Backspace' && !labelInput.value && labels.length) {
    labels.pop();
    renderLabels();
    refreshPreview();
  }
});

document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.preset;
    if (preset === 'clear') {
      labels = [];
      renderLabels();
      return;
    }
    addLabels(PRESETS[preset].join(','));
  });
});

/* --------------------------------------------------------------- scraping */

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  // A label typed but not yet added is clearly intended.
  if (labelInput.value.trim()) {
    addLabels(labelInput.value);
    labelInput.value = '';
  }
  if (!labels.length) {
    setStatus('Add at least one label first.', true);
    labelInput.focus();
    return;
  }

  const options = {
    mode: document.getElementById('mode').value,
    maxPages: Number(document.getElementById('maxPages').value) || 5,
    render: document.getElementById('render').value,
    minConfidence: Number(document.getElementById('minConfidence').value),
    followInternalLinks: document.getElementById('followInternalLinks').checked,
    allowPagination: document.getElementById('allowPagination').checked,
    maxPaginationPages: document.getElementById('allPages').checked
      ? 'all'
      : Number(document.getElementById('maxPaginationPages').value) || 2,
    exhaustScroll: document.getElementById('exhaustScroll').checked,
    clickLoadMore: document.getElementById('clickLoadMore').checked,
    useLlm: document.getElementById('useLlm').checked,
  };

  submitBtn.disabled = true;
  submitBtn.textContent = 'Scraping…';
  setStatus('Fetching and analysing — this can take 10-40s when rendering is needed.');

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlInput.value, labels, options }),
    });
    const payload = await res.json();

    if (!res.ok) {
      setStatus(payload.error ?? `Request failed (${res.status}).`, true);
      return;
    }
    lastResult = payload;
    renderResult(payload);
    setStatus('');
  } catch (err) {
    setStatus(`Could not reach the server: ${err.message}`, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Start Scraping';
  }
});

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle('bad', isError);
}

/* ---------------------------------------------------------------- results */

function renderResult(result) {
  results.hidden = false;

  const isList = result.mode === 'list';
  const secs = result.duration_ms ? ` in ${(result.duration_ms / 1000).toFixed(1)}s` : '';

  if (isList) {
    const statusWord = { ok: 'Every column filled', partial: 'Some columns incomplete', error: 'Failed' }[result.status] ?? result.status;
    resultsSummary.textContent =
      `${statusWord} — ${result.record_count} record(s) × ${result.labels?.length ?? 0} labels, ` +
      `${result.stats?.pages_fetched ?? 0} page(s) fetched${secs}`;
  } else {
    const { labels_found: found, labels_requested: requested } = result.stats ?? {};
    const statusWord = { ok: 'All labels found', partial: 'Partially complete', error: 'Failed' }[result.status] ?? result.status;
    resultsSummary.textContent =
      `${statusWord} — ${found ?? 0}/${requested ?? 0} labels, ` +
      `${result.stats?.pages_fetched ?? 0} page(s) fetched${secs}`;
  }

  // Notices: errors first, then warnings (collapsed if numerous).
  notices.replaceChildren();
  for (const err of result.errors ?? []) {
    notices.append(notice(`${err.type}: ${err.message}`, 'error'));
  }
  const warnings = result.warnings ?? [];
  for (const w of warnings.slice(0, 5)) notices.append(notice(w, 'warn'));
  if (warnings.length > 5) {
    notices.append(notice(`…and ${warnings.length - 5} more warnings (see raw JSON).`, 'warn'));
  }
  // Why the walk stopped is the first thing you want to know when a list came
  // back shorter than expected.
  if (isList && result.pagination) {
    const p = result.pagination;
    notices.append(
      notice(
        `Pagination: walked ${p.pages_walked} page(s)` +
          (p.scrolled ? ', with scrolling' : '') +
          ` — stopped because ${p.stopped_because}.`,
        p.stopped_because.includes('is off') || p.stopped_because.includes('cap') ? 'warn' : 'info',
      ),
    );
  }

  if (result.missing_fields?.length) {
    notices.append(notice(`Not found on this site: ${result.missing_fields.join(', ')}. These are reported as null rather than guessed.`, 'warn'));
  }

  // Table — the two modes are different tables, not the same one with a flag.
  if (isList) renderRecordTable(result);
  else renderFieldTable(result);

  // Pages visited
  pagesList.replaceChildren();
  for (const page of result.pages_visited ?? []) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = page.final_url ?? page.url;
    a.textContent = page.final_url ?? page.url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    li.append(a);
    const meta = document.createElement('span');
    meta.className = 'how-cell';
    meta.textContent = ` — HTTP ${page.status}, ${page.renderer}${page.reasons?.length ? `, ${page.reasons.join('; ')}` : ''}`;
    li.append(meta);
    pagesList.append(li);
  }

  rawJson.textContent = JSON.stringify(result, null, 2);
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Single-record view: one row per label, with provenance. */
function renderFieldTable(result) {
  thead.replaceChildren(headerRow(['Label', 'Extracted Value', 'Source', 'How']));
  tbody.replaceChildren();
  for (const [key, field] of Object.entries(result.fields ?? {})) {
    tbody.append(fieldRow(key, field));
  }
}

/**
 * List view: one row per record, one column per label — the spreadsheet a
 * directory page is really asking to become.
 */
function renderRecordTable(result) {
  const keys = result.record_fields?.[0]
    ? Object.keys(result.record_fields[0])
    : Object.keys(result.records?.[0] ?? {}).filter((k) => !k.startsWith('_'));

  const headers = keys.map((key) => {
    const cov = result.field_coverage?.[key];
    return cov ? `${cov.label} (${cov.percent}%)` : key;
  });
  thead.replaceChildren(headerRow(['#', ...headers]));

  tbody.replaceChildren();
  (result.records ?? []).forEach((record, i) => {
    const tr = document.createElement('tr');

    const num = document.createElement('td');
    num.className = 'how-cell';
    num.textContent = String(i + 1);
    tr.append(num);

    for (const key of keys) {
      const td = document.createElement('td');
      td.className = 'value-cell';
      const provenance = result.record_fields?.[i]?.[key];
      td.append(
        renderValue({
          value: record[key],
          value_type: provenance?.value_type ?? guessType(key),
          found: provenance?.found ?? record[key] != null,
        }),
      );
      if (provenance?.method) td.title = `${provenance.method} (confidence ${provenance.confidence})`;
      tr.append(td);
    }
    tbody.append(tr);
  });

  if (!result.records?.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = keys.length + 1;
    td.className = 'null-value';
    td.textContent = 'No list items were found on this page.';
    tr.append(td);
    tbody.append(tr);
  }
}

function headerRow(names) {
  const tr = document.createElement('tr');
  for (const name of names) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = name;
    tr.append(th);
  }
  return tr;
}

/** Fallback when a record column has no provenance to state its type. */
function guessType(key) {
  if (/image|photo|picture|logo/.test(key)) return 'image';
  if (/email/.test(key)) return 'email';
  if (/phone|tel|mobile|fax/.test(key)) return 'phone';
  if (/website|url|link|facebook|instagram/.test(key)) return 'url';
  return 'text';
}

function fieldRow(key, field) {
  const tr = document.createElement('tr');

  const labelCell = document.createElement('td');
  labelCell.className = 'label-cell';
  labelCell.textContent = field.label;
  const keyHint = document.createElement('span');
  keyHint.className = 'conf';
  keyHint.textContent = key;
  labelCell.append(document.createElement('br'), keyHint);
  tr.append(labelCell);

  const valueCell = document.createElement('td');
  valueCell.className = 'value-cell';
  valueCell.append(renderValue(field));
  tr.append(valueCell);

  const sourceCell = document.createElement('td');
  sourceCell.className = 'source-cell';
  if (field.source_url) {
    const a = document.createElement('a');
    a.href = field.source_url;
    a.textContent = shortUrl(field.source_url);
    a.title = field.source_url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    sourceCell.append(a);
  } else {
    sourceCell.textContent = '—';
  }
  tr.append(sourceCell);

  const howCell = document.createElement('td');
  howCell.className = 'how-cell';
  if (field.found) {
    howCell.textContent = field.method ?? '';
    const conf = document.createElement('span');
    conf.className = 'conf';
    conf.textContent = `confidence ${field.confidence}`;
    howCell.append(document.createElement('br'), conf);
    if (field.selector) {
      const sel = document.createElement('code');
      sel.textContent = field.selector;
      howCell.append(document.createElement('br'), sel);
    }
  } else {
    howCell.textContent = 'not found';
  }
  tr.append(howCell);

  return tr;
}

function renderValue(field) {
  const isImage = field.value_type === 'image' || field.value_type === 'image_list';

  if (field.value == null || (Array.isArray(field.value) && !field.value.length)) {
    const span = document.createElement('span');
    span.className = 'null-value';
    span.textContent = 'null';
    return span;
  }

  if (Array.isArray(field.value)) {
    const wrap = document.createElement('div');
    const ul = document.createElement('ul');
    ul.className = 'value-list';
    for (const v of field.value) {
      const li = document.createElement('li');
      li.append(isImage ? linkTo(v) : document.createTextNode(v));
      ul.append(li);
    }
    wrap.append(ul);
    if (isImage) wrap.append(thumbs(field.value));
    return wrap;
  }

  if (isImage) {
    const wrap = document.createElement('div');
    wrap.append(linkTo(field.value), thumbs([field.value]));
    return wrap;
  }
  if (field.value_type === 'url' || field.value_type === 'social') {
    return linkTo(field.value);
  }
  if (field.value_type === 'email') {
    return linkTo(field.value, `mailto:${field.value}`);
  }
  if (field.value_type === 'phone') {
    return linkTo(field.value, `tel:${field.value}`);
  }

  const span = document.createElement('span');
  span.textContent = field.value;
  return span;
}

function thumbs(urls) {
  const div = document.createElement('div');
  div.className = 'thumbs';
  for (const url of urls.slice(0, 12)) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    // A hotlink-protected image should not leave a broken icon in the table.
    img.addEventListener('error', () => img.remove());
    div.append(img);
  }
  return div;
}

function linkTo(text, href = text) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  return a;
}

function notice(text, kind) {
  const div = document.createElement('div');
  div.className = `notice ${kind}`;
  div.textContent = text;
  return div;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

/* ---------------------------------------------------------------- exports */

toggleRaw.addEventListener('click', () => {
  rawJson.hidden = !rawJson.hidden;
  toggleRaw.textContent = rawJson.hidden ? 'Show raw JSON' : 'Hide raw JSON';
});

document.getElementById('export-json').addEventListener('click', () => download('json'));
document.getElementById('export-csv').addEventListener('click', () => download('csv'));

async function download(format) {
  if (!lastResult) return;

  // Prefer the server route: it sets a real filename via Content-Disposition.
  // But on serverless hosting each request can hit a different instance, so
  // the result may not be in *this* instance's memory — hence probe with fetch
  // rather than navigating, and build the file locally when it is not there.
  if (lastResult.id) {
    try {
      const res = await fetch(`/api/export/${lastResult.id}.${format}`);
      if (res.ok) {
        saveBlob(await res.blob(), `${hostOf(lastResult.url)}.${format}`);
        return;
      }
    } catch {
      /* fall through to the local path */
    }
  }

  const text = format === 'json' ? JSON.stringify(lastResult, null, 2) : toCsvClient(lastResult);
  saveBlob(
    new Blob([text], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }),
    `${hostOf(lastResult.url)}.${format}`,
  );
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
  } catch {
    return 'scrape';
  }
}

function toCsvClient(result) {
  if (result.mode === 'list') {
    const keys = Object.keys(result.record_fields?.[0] ?? {});
    const rows = [[...keys, 'source_url']];
    for (const r of result.records ?? []) {
      rows.push([...keys.map((k) => (Array.isArray(r[k]) ? r[k].join(' | ') : r[k] ?? '')), r._source_url ?? '']);
    }
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  }
  const rows = [['label', 'field_key', 'value', 'value_type', 'source_url', 'method', 'confidence', 'found']];
  for (const [key, f] of Object.entries(result.fields ?? {})) {
    rows.push([
      f.label, key, Array.isArray(f.value) ? f.value.join(' | ') : f.value ?? '',
      f.value_type ?? '', f.source_url ?? '', f.method ?? '', f.confidence ?? '', f.found ? 'yes' : 'no',
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Quote a CSV cell, and neutralise values a spreadsheet would run as a formula. */
function csvCell(value) {
  const s = value == null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/* ----------------------------------------------------- Google Places tab */

const placesForm = document.getElementById('places-form');
const placesQuery = document.getElementById('places-query');
const placesLabelInput = document.getElementById('places-label-input');
const placesLabelList = document.getElementById('places-label-list');
const placesStatus = document.getElementById('places-status');
const placesSubmit = document.getElementById('places-submit');

const PLACES_PRESETS = {
  business: ['Name', 'Address', 'Phone Number', 'Website', 'Rating', 'Reviews', 'Opening Hours', 'Category'],
  geo: ['Name', 'Address', 'Latitude', 'Longitude', 'Rating', 'Google Maps Link', 'Photo'],
};

/** @type {string[]} */
let placesLabels = [];

function renderPlacesLabels() {
  placesLabelList.replaceChildren();
  for (const label of placesLabels) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = label;
    li.append(name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${label}`);
    remove.addEventListener('click', () => {
      placesLabels = placesLabels.filter((l) => l !== label);
      renderPlacesLabels();
    });
    li.append(remove);
    placesLabelList.append(li);
  }
}

function addPlacesLabels(input) {
  let added = 0;
  for (const part of String(input).split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    if (placesLabels.some((l) => l.toLowerCase() === part.toLowerCase())) continue;
    placesLabels.push(part);
    added += 1;
  }
  if (added) renderPlacesLabels();
  return added;
}

document.getElementById('places-add-label').addEventListener('click', () => {
  if (addPlacesLabels(placesLabelInput.value)) placesLabelInput.value = '';
  placesLabelInput.focus();
});

placesLabelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    if (addPlacesLabels(placesLabelInput.value)) placesLabelInput.value = '';
  } else if (e.key === 'Backspace' && !placesLabelInput.value && placesLabels.length) {
    placesLabels.pop();
    renderPlacesLabels();
  }
});

document.querySelectorAll('[data-places-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.placesPreset;
    if (preset === 'clear') {
      placesLabels = [];
      renderPlacesLabels();
      return;
    }
    addPlacesLabels(PLACES_PRESETS[preset].join(','));
  });
});

placesForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (placesLabelInput.value.trim()) {
    addPlacesLabels(placesLabelInput.value);
    placesLabelInput.value = '';
  }
  if (!placesQuery.value.trim()) {
    setPlacesStatus('Enter a search query first, e.g. "beauty salons in Yangon".', true);
    placesQuery.focus();
    return;
  }
  if (!placesLabels.length) {
    setPlacesStatus('Add at least one field.', true);
    placesLabelInput.focus();
    return;
  }

  placesSubmit.disabled = true;
  placesSubmit.textContent = 'Searching…';
  setPlacesStatus('Querying the Places API…');

  try {
    const res = await fetch('/api/places', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: placesQuery.value,
        labels: placesLabels,
        options: {
          maxResults: Number(document.getElementById('places-max').value) || 20,
          maxPhotosPerPlace: Number(document.getElementById('places-photos').value) || 0,
          languageCode: document.getElementById('places-lang').value.trim() || undefined,
        },
      }),
    });
    const payload = await res.json();
    if (!res.ok) {
      setPlacesStatus(payload.detail ?? payload.error ?? `Request failed (${res.status}).`, true);
      return;
    }
    lastResult = payload;
    renderResult(payload);
    setPlacesStatus('');
  } catch (err) {
    setPlacesStatus(`Could not reach the server: ${err.message}`, true);
  } finally {
    placesSubmit.disabled = false;
    placesSubmit.textContent = 'Search Places';
  }
});

function setPlacesStatus(text, isError = false) {
  placesStatus.textContent = text;
  placesStatus.classList.toggle('bad', isError);
}

/* --------------------------------------------------------------- tabbing */

const tabs = [
  { tab: document.getElementById('tab-website'), panel: form },
  { tab: document.getElementById('tab-places'), panel: placesForm },
];

for (const { tab } of tabs) {
  tab.addEventListener('click', () => {
    for (const entry of tabs) {
      const isActive = entry.tab === tab;
      entry.tab.classList.toggle('active', isActive);
      entry.tab.setAttribute('aria-selected', String(isActive));
      entry.panel.hidden = !isActive;
    }
    // Results from the other source would be confusing next to a fresh form.
    results.hidden = true;
  });
}

/* ------------------------------------------------------------------- init */

(async function init() {
  renderLabels();
  try {
    const health = await (await fetch('/api/health')).json();

    llmHint.textContent = health.llm ? '' : 'Needs ANTHROPIC_API_KEY on the server.';
    document.getElementById('useLlm').disabled = !health.llm;

    // Say up front whether the Places tab can work, rather than after a search.
    const placesHint = document.getElementById('places-hint');
    if (!health.places) {
      placesHint.textContent = health.placesNote ?? 'Not configured on this server.';
      placesSubmit.disabled = true;
      placesSubmit.title = 'GOOGLE_MAPS_API_KEY is not set on the server';
    }

    // Say what this deployment cannot do *before* someone ticks a box that
    // will be silently ignored.
    if (health.renderer === 'unavailable') {
      const renderSelect = document.getElementById('render');
      const scroll = document.getElementById('exhaustScroll');
      const loadMore = document.getElementById('clickLoadMore');

      renderSelect.value = 'never';
      renderSelect.disabled = true;
      scroll.checked = false;
      scroll.disabled = true;
      loadMore.checked = false;
      loadMore.disabled = true;

      const banner = document.createElement('div');
      banner.className = 'notice warn';
      banner.textContent = health.serverless
        ? 'Static-only on this deployment: no browser is available, so JavaScript-built pages and infinite scroll will not work here. Everything else does. Run it locally with `npm start` for full rendering.'
        : `Browser rendering unavailable: ${health.rendererNote}`;
      document.querySelector('.advanced').prepend(banner);
    }
  } catch {
    /* server health is informational */
  }
})();
