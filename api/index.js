/**
 * Vercel serverless entry point.
 *
 * A serverless function exports a request handler; it must not bind a port.
 * `createApp()` returns the Express app without starting a listener, and an
 * Express app *is* a `(req, res)` handler.
 *
 * The app is built lazily inside a try/catch rather than at module scope, for
 * a specific reason: if anything throws while the module is being evaluated,
 * the platform reports only a generic FUNCTION_INVOCATION_FAILED with no
 * detail, and there is nothing to debug from outside. Catching it here turns a
 * cold-start crash into a readable response.
 *
 * Only /api/* reaches this function. The UI in public/ is served directly by
 * the platform's static hosting (see vercel.json: outputDirectory plus an
 * /api-only rewrite). Routing the static files *through* the function crashed
 * it outright — and a static asset has no business costing a function
 * invocation anyway. createApp() still mounts express.static, so `npm start`
 * serves the UI locally from the same code.
 *
 * No Renderer is passed: a serverless function has no Chromium and a hard time
 * limit, so src/server.js forces `render: 'never'` when it detects a
 * serverless environment. Static extraction — JSON-LD, Open Graph, semantic
 * HTML, label proximity, list records, numbered pagination — all work here.
 * JavaScript-rendered pages and infinite scroll need a normal Node process.
 */

/** @type {import('express').Express | null} */
let app = null;
/** @type {Error | null} */
let bootError = null;

async function getApp() {
  if (app) return app;
  if (bootError) throw bootError;
  try {
    const { createApp } = await import('../src/server.js');
    app = createApp();
    return app;
  } catch (err) {
    bootError = err instanceof Error ? err : new Error(String(err));
    throw bootError;
  }
}

export default async function handler(req, res) {
  try {
    const expressApp = await getApp();
    return expressApp(req, res);
  } catch (err) {
    // Report the real cause instead of a bare platform error.
    console.error('function boot failed:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify(
        {
          error: 'The scraper function failed to start.',
          message: err?.message ?? String(err),
          code: err?.code ?? null,
          node: process.version,
          cwd: process.cwd(),
          stack: String(err?.stack ?? '').split('\n').slice(0, 8),
        },
        null,
        2,
      ),
    );
    return undefined;
  }
}
