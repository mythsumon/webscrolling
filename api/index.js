/**
 * Vercel serverless entry point.
 *
 * A serverless function exports a request handler; it must not bind a port.
 * `createApp()` returns the Express app without starting a listener, and an
 * Express app *is* a `(req, res)` handler, so it can be exported directly.
 *
 * No `Renderer` is passed: a serverless function has no Chromium and a hard
 * time limit, so `src/server.js` forces `render: 'never'` when it detects a
 * serverless environment. Static extraction — JSON-LD, Open Graph, semantic
 * HTML, label proximity, list records, numbered pagination — all work here.
 * JavaScript-rendered pages and infinite scroll need `npm start` on a normal
 * server.
 */

import { createApp } from '../src/server.js';

export default createApp();
