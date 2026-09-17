/**
 * Express API + static UI.
 *
 * One shared Renderer across requests, so repeated scrapes reuse one Chromium
 * process. Requests are serialised per host by the Fetcher itself; this server
 * additionally caps how many scrapes run at once, because each one can hold a
 * browser context.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { scrape, DEFAULT_OPTIONS } from './core/pipeline.js';
import { Renderer } from './core/renderer.js';
import { toCsv, toJson } from './output/exporters.js';
import { parseLabels } from './extract/labels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_SCRAPES ?? 2);
const MAX_LABELS = 40;

const app = express();
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));

const renderer = new Renderer({
  timeoutMs: Number(process.env.RENDER_TIMEOUT_MS ?? 30000),
  logger: { warn: (...a) => console.warn(...a), info: () => {}, debug: () => {}, error: (...a) => console.error(...a) },
});

let active = 0;
/** @type {Map<string, object>} Recent results, so /export can serve a CSV. */
const recent = new Map();
const RECENT_LIMIT = 50;

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    renderer: renderer.available === false ? 'unavailable' : renderer.available ? 'ready' : 'not yet started',
    rendererNote: renderer.unavailableReason ?? null,
    llm: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    defaults: DEFAULT_OPTIONS,
  });
});

/** Preview how labels will be interpreted, without fetching anything. */
app.post('/api/labels/preview', (req, res) => {
  const labels = Array.isArray(req.body?.labels) ? req.body.labels : [];
  const specs = parseLabels(labels.slice(0, MAX_LABELS));
  res.json({
    specs: specs.map((s) => ({
      label: s.label,
      key: s.key,
      type: s.type,
      plural: s.plural,
      matched: s.ontologyKey,
      keywords: s.keywords.slice(0, 8),
    })),
  });
});

app.post('/api/scrape', async (req, res) => {
  const { url, labels, options = {} } = req.body ?? {};

  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'A "url" string is required.' });
  }
  if (!Array.isArray(labels) || !labels.length) {
    return res.status(400).json({ error: 'A non-empty "labels" array is required.' });
  }
  if (labels.length > MAX_LABELS) {
    return res.status(400).json({ error: `Too many labels (max ${MAX_LABELS}).` });
  }
  if (active >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'Server is busy running other scrapes. Try again shortly.' });
  }

  active += 1;
  const startedAt = Date.now();
  try {
    const result = await scrape({
      url,
      labels: labels.map(String),
      options: sanitiseOptions(options),
      renderer,
    });
    result.duration_ms = Date.now() - startedAt;

    const id = randomUUID();
    result.id = id;
    recent.set(id, result);
    if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value);

    res.json(result);
  } catch (err) {
    console.error('scrape failed:', err);
    res.status(500).json({
      error: 'Scrape failed unexpectedly.',
      detail: err.message,
    });
  } finally {
    active -= 1;
  }
});

app.get('/api/export/:id.:format', (req, res) => {
  const result = recent.get(req.params.id);
  if (!result) return res.status(404).json({ error: 'Result not found (results are kept in memory only).' });

  const host = safeHost(result.url);
  const stamp = new Date().toISOString().slice(0, 10);

  if (req.params.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${host}-${stamp}.csv"`);
    return res.send(toCsv(result));
  }
  if (req.params.format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${host}-${stamp}.json"`);
    return res.send(toJson(result));
  }
  return res.status(400).json({ error: 'Format must be csv or json.' });
});

/** Only accept options we understand, with sane bounds. */
function sanitiseOptions(raw) {
  const clampNum = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    maxPages: clampNum(raw.maxPages, 1, 15, DEFAULT_OPTIONS.maxPages),
    mode: ['auto', 'list', 'single'].includes(raw.mode) ? raw.mode : DEFAULT_OPTIONS.mode,
    maxRecords: clampNum(raw.maxRecords, 1, 2000, DEFAULT_OPTIONS.maxRecords),
    followInternalLinks: raw.followInternalLinks !== false,
    allowPagination: raw.allowPagination === true,
    maxPaginationPages:
      raw.maxPaginationPages === 'all'
        ? 'all'
        : clampNum(raw.maxPaginationPages, 1, 500, DEFAULT_OPTIONS.maxPaginationPages),
    exhaustScroll: raw.exhaustScroll === true,
    maxLoadMoreClicks: clampNum(raw.maxLoadMoreClicks, 0, 100, DEFAULT_OPTIONS.maxLoadMoreClicks),
    scrollBudgetMs: clampNum(raw.scrollBudgetMs, 2000, 180000, DEFAULT_OPTIONS.scrollBudgetMs),
    render: ['auto', 'always', 'never'].includes(raw.render) ? raw.render : DEFAULT_OPTIONS.render,
    clickLoadMore: raw.clickLoadMore === true,
    useLlm: raw.useLlm === true,
    llmModel: typeof raw.llmModel === 'string' ? raw.llmModel : undefined,
    minConfidence: clampNum(raw.minConfidence, 0, 0.95, DEFAULT_OPTIONS.minConfidence),
    minDelayMs: clampNum(raw.minDelayMs, 250, 10000, DEFAULT_OPTIONS.minDelayMs),
    requestTimeoutMs: clampNum(raw.requestTimeoutMs, 3000, 60000, DEFAULT_OPTIONS.requestTimeoutMs),
    // robots.txt compliance is not client-configurable: a browser UI is not the
    // right place to opt out of a site's stated policy. Use the CLI flag.
    obeyRobots: true,
    logLevel: 'silent',
  };
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
  } catch {
    return 'scrape';
  }
}

const server = app.listen(PORT, () => {
  console.log(`Label scraper UI:  http://localhost:${PORT}`);
  console.log(`API:               POST http://localhost:${PORT}/api/scrape`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log('Note: ANTHROPIC_API_KEY is not set, so the optional LLM fallback is unavailable.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n${signal} — shutting down`);
    server.close();
    await renderer.close();
    process.exit(0);
  });
}
