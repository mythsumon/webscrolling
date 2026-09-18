/**
 * Express API + static UI.
 *
 * Exported as `createApp()` rather than started on import, so the same code
 * runs two ways:
 *   - a long-lived process (`npm start`), which is the full-featured mode:
 *     Chromium rendering, a shared browser, no request time limit
 *   - a serverless function (`api/index.js` on Vercel), which cannot run a
 *     browser and is time-limited, so rendering is refused rather than
 *     attempted — see `SERVERLESS` below
 *
 * A serverless function that called `app.listen()` would simply fail to
 * invoke, which is exactly the 500 FUNCTION_INVOCATION_FAILED it produced.
 */

import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { scrape, DEFAULT_OPTIONS } from './core/pipeline.js';
import { Renderer } from './core/renderer.js';
import { toCsv, toJson } from './output/exporters.js';
import { parseLabels } from './extract/labels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const MAX_LABELS = 40;

/**
 * Are we inside a serverless function? Vercel, Netlify and Lambda all set one
 * of these. It changes three things: no browser, tighter budgets, and no
 * reliance on server memory between requests.
 */
export const SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY,
);

/** Ceilings that keep a scrape inside a serverless function's time limit. */
const SERVERLESS_LIMITS = {
  maxPages: 3,
  maxRecords: 60,
  maxPaginationPages: 4,
  minDelayMs: 600,
  requestTimeoutMs: 12000,
};

export function createApp({ renderer = null } = {}) {
  const app = express();
  app.use(express.json({ limit: '128kb' }));

  // Serve the UI only when the directory is actually present. In a serverless
  // bundle it is not — the platform serves public/ from its CDN and only
  // /api/* reaches this function — and mounting a static handler on a missing
  // root is a needless failure mode for a path that should never arrive here.
  const hasPublicDir = existsSync(PUBLIC_DIR);
  if (hasPublicDir) {
    app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  } else {
    // Belt and braces: if a request for the UI does reach the function anyway,
    // hand it to the CDN copy rather than failing.
    app.get('/', (_req, res) => res.redirect(302, '/index.html'));
  }

  const maxConcurrent = Number(process.env.MAX_CONCURRENT_SCRAPES ?? 2);
  let active = 0;

  /**
   * Recent results, so /api/export can serve a file.
   *
   * On a serverless platform each request may land on a different instance, so
   * this is a best-effort cache only — the UI falls back to building the file
   * client-side when a lookup misses.
   */
  const recent = new Map();
  const RECENT_LIMIT = 50;

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      serverless: SERVERLESS,
      renderer: SERVERLESS
        ? 'unavailable'
        : renderer?.available === false
          ? 'unavailable'
          : renderer?.available
            ? 'ready'
            : 'not yet started',
      rendererNote: SERVERLESS
        ? 'Browser rendering is not available on serverless hosting: no Chromium, and scrapes must finish inside the function time limit. JavaScript-built pages and infinite scroll need `npm start` on a normal server.'
        : renderer?.unavailableReason ?? null,
      llm: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
      places: Boolean(process.env.GOOGLE_MAPS_API_KEY),
      placesNote: process.env.GOOGLE_MAPS_API_KEY
        ? null
        : 'Set GOOGLE_MAPS_API_KEY (with "Places API (New)" enabled) to use the Google Places tab. It is Google\'s official API, not a Maps scrape, so a key is required and each search is billed to your project.',
      limits: SERVERLESS ? SERVERLESS_LIMITS : null,
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
    if (active >= maxConcurrent) {
      return res.status(503).json({ error: 'Server is busy running other scrapes. Try again shortly.' });
    }

    active += 1;
    const startedAt = Date.now();
    try {
      const result = await scrape({
        url,
        labels: labels.map(String),
        options: sanitiseOptions(options),
        renderer: SERVERLESS ? undefined : renderer ?? undefined,
      });
      result.duration_ms = Date.now() - startedAt;

      if (SERVERLESS && (options.render === 'always' || options.exhaustScroll)) {
        result.warnings = [
          'Browser rendering and scrolling were requested but are unavailable on serverless hosting — this ran static-only. Run `npm start` locally for those.',
          ...(result.warnings ?? []),
        ];
      }

      const id = randomUUID();
      result.id = id;
      recent.set(id, result);
      if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value);

      res.json(result);
    } catch (err) {
      console.error('scrape failed:', err);
      res.status(500).json({ error: 'Scrape failed unexpectedly.', detail: err.message });
    } finally {
      active -= 1;
    }
  });

  /**
   * Google Places search — the supported route to "the list from Google Maps".
   * See src/sources/googlePlaces.js for why this is an API call rather than a
   * scrape. Billed to the caller's own key, so the result limit is capped.
   */
  app.post('/api/places', async (req, res) => {
    const { query, labels, options = {} } = req.body ?? {};

    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'A "query" string is required, for example "beauty salons in Yangon".' });
    }
    if (!Array.isArray(labels) || !labels.length) {
      return res.status(400).json({ error: 'A non-empty "labels" array is required.' });
    }
    if (labels.length > MAX_LABELS) {
      return res.status(400).json({ error: `Too many labels (max ${MAX_LABELS}).` });
    }
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({
        error: 'Google Places is not configured on this server.',
        detail: 'Set GOOGLE_MAPS_API_KEY with "Places API (New)" enabled for the project. This uses Google\'s official API rather than scraping Maps, so a key is required and Google bills your project per search.',
      });
    }
    if (active >= maxConcurrent) {
      return res.status(503).json({ error: 'Server is busy. Try again shortly.' });
    }

    active += 1;
    const startedAt = Date.now();
    try {
      const { searchGooglePlaces } = await import('./sources/googlePlaces.js');
      const result = await searchGooglePlaces({
        query,
        labels: labels.map(String),
        options: {
          // Cost control: the client may not ask for unlimited billed calls.
          maxResults: Math.min(Number(options.maxResults) || 20, 60),
          maxPhotosPerPlace: Math.min(Math.max(Number(options.maxPhotosPerPlace) || 1, 0), 3),
          languageCode: typeof options.languageCode === 'string' ? options.languageCode : undefined,
          regionCode: typeof options.regionCode === 'string' ? options.regionCode : undefined,
        },
      });
      result.duration_ms = Date.now() - startedAt;

      const id = randomUUID();
      result.id = id;
      recent.set(id, result);
      if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value);

      res.json(result);
    } catch (err) {
      console.error('places search failed:', err);
      res.status(500).json({ error: 'Places search failed unexpectedly.', detail: err.message });
    } finally {
      active -= 1;
    }
  });

  app.get('/api/export/:id.:format', (req, res) => {
    const result = recent.get(req.params.id);
    if (!result) {
      // Expected on serverless: a different instance served the scrape. The UI
      // builds the file from the result it already holds.
      return res.status(404).json({ error: 'Result not held by this instance; export it client-side.' });
    }

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

  return app;
}

/** Only accept options we understand, with sane bounds. */
function sanitiseOptions(raw) {
  const clampNum = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const cap = (value, limit) => (SERVERLESS ? Math.min(value, limit) : value);

  const opts = {
    mode: ['auto', 'list', 'single'].includes(raw.mode) ? raw.mode : DEFAULT_OPTIONS.mode,
    maxRecords: cap(clampNum(raw.maxRecords, 1, 2000, DEFAULT_OPTIONS.maxRecords), SERVERLESS_LIMITS.maxRecords),
    maxPages: cap(clampNum(raw.maxPages, 1, 15, DEFAULT_OPTIONS.maxPages), SERVERLESS_LIMITS.maxPages),
    followInternalLinks: raw.followInternalLinks !== false,
    allowPagination: raw.allowPagination === true,
    maxPaginationPages:
      raw.maxPaginationPages === 'all'
        ? (SERVERLESS ? SERVERLESS_LIMITS.maxPaginationPages : 'all')
        : cap(
          clampNum(raw.maxPaginationPages, 1, 500, DEFAULT_OPTIONS.maxPaginationPages),
          SERVERLESS_LIMITS.maxPaginationPages,
        ),
    // Rendering and scrolling both need a browser, which serverless has not
    // got. Refusing up front beats a 60-second timeout.
    render: SERVERLESS ? 'never' : ['auto', 'always', 'never'].includes(raw.render) ? raw.render : DEFAULT_OPTIONS.render,
    exhaustScroll: SERVERLESS ? false : raw.exhaustScroll === true,
    clickLoadMore: SERVERLESS ? false : raw.clickLoadMore === true,
    maxLoadMoreClicks: clampNum(raw.maxLoadMoreClicks, 0, 100, DEFAULT_OPTIONS.maxLoadMoreClicks),
    scrollBudgetMs: clampNum(raw.scrollBudgetMs, 2000, 180000, DEFAULT_OPTIONS.scrollBudgetMs),
    useLlm: raw.useLlm === true,
    llmModel: typeof raw.llmModel === 'string' ? raw.llmModel : undefined,
    minConfidence: clampNum(raw.minConfidence, 0, 0.95, DEFAULT_OPTIONS.minConfidence),
    minDelayMs: SERVERLESS
      ? SERVERLESS_LIMITS.minDelayMs
      : clampNum(raw.minDelayMs, 250, 10000, DEFAULT_OPTIONS.minDelayMs),
    requestTimeoutMs: cap(
      clampNum(raw.requestTimeoutMs, 3000, 60000, DEFAULT_OPTIONS.requestTimeoutMs),
      SERVERLESS_LIMITS.requestTimeoutMs,
    ),
    // robots.txt compliance is not client-configurable: a browser UI is not the
    // right place to opt out of a site's stated policy. Use the CLI flag.
    obeyRobots: true,
    logLevel: 'silent',
  };
  return opts;
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
  } catch {
    return 'scrape';
  }
}

/* ------------------------------------------------- long-lived process mode */

export function startServer({ port = Number(process.env.PORT ?? 3000) } = {}) {
  const renderer = new Renderer({
    timeoutMs: Number(process.env.RENDER_TIMEOUT_MS ?? 30000),
    logger: {
      warn: (...a) => console.warn(...a),
      info: () => {},
      debug: () => {},
      error: (...a) => console.error(...a),
    },
  });

  const app = createApp({ renderer });
  const server = app.listen(port, () => {
    console.log(`Label scraper UI:  http://localhost:${port}`);
    console.log(`API:               POST http://localhost:${port}/api/scrape`);
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

  return { app, server, renderer };
}

// Start only when run directly, so importing this module (tests, the
// serverless entry) does not bind a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
