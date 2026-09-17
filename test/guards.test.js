/** Access-restriction detection and the LLM tier's guard rails. */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';

import { detectRestriction, detectLoginWall } from '../src/core/guards.js';
import { resolveWithLlm } from '../src/extract/llm.js';
import { parseLabel } from '../src/extract/labels.js';

test('HTTP status codes map to typed restrictions', () => {
  assert.equal(detectRestriction({ status: 401, html: '', text: '' }).type, 'login_required');
  assert.equal(detectRestriction({ status: 403, html: '', text: '' }).type, 'blocked');
  assert.equal(detectRestriction({ status: 429, html: '', text: '' }).type, 'rate_limited');
  assert.equal(detectRestriction({ status: 402, html: '', text: '' }).type, 'paywall');
  assert.equal(detectRestriction({ status: 200, html: '<p>hi</p>', text: 'hi' }), null);
});

test('CAPTCHA and anti-bot challenges are detected, never bypassed', () => {
  const recaptcha = detectRestriction({
    status: 200,
    html: '<div class="g-recaptcha" data-sitekey="x"></div>',
    text: 'Please verify',
  });
  assert.equal(recaptcha.type, 'captcha');
  assert.match(recaptcha.message, /[Nn]ot attempting to bypass/);

  assert.equal(
    detectRestriction({ status: 200, html: '<script src="https://challenges.cloudflare.com/turnstile"></script>', text: '' }).type,
    'captcha',
  );
  assert.equal(
    detectRestriction({ status: 200, html: '<title>Just a moment...</title>', text: 'Just a moment... checking your browser' }).type,
    'captcha',
  );
});

test('a long article merely mentioning a challenge phrase is not a challenge', () => {
  const text = `Just a moment, we said. ${'This is a long article about anti-bot systems. '.repeat(40)}`;
  assert.equal(detectRestriction({ status: 200, html: `<p>${text}</p>`, text }), null);
});

test('a login wall is a password field with no other content', () => {
  const wall = cheerio.load('<form><input type="password"></form><p>Sign in to continue.</p>');
  assert.equal(detectLoginWall(wall, 'Sign in to continue.').type, 'login_required');

  // A member-login form in the header of a normal page is not a login wall.
  const normal = cheerio.load('<header><input type="password"></header><main><p>content</p></main>');
  assert.equal(detectLoginWall(normal, 'Real content. '.repeat(300)), null);
});

test('the LLM tier is skipped with a clear warning when no credential is set', async (t) => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  t.after(() => {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
  });

  const out = await resolveWithLlm({
    specs: [parseLabel('Founder')],
    pages: [{ url: 'https://x.example/', digest: 'Founded in 1998 by Ana Villareal.' }],
  });
  assert.deepEqual(out.candidates, {});
  assert.equal(out.errors.length, 0, 'a missing key is a warning, not an error');
  assert.match(out.warnings[0], /ANTHROPIC_API_KEY/);
});

test('the LLM tier asks for nothing when every label is already resolved', async () => {
  const out = await resolveWithLlm({ specs: [], pages: [] });
  assert.deepEqual(out.candidates, {});
  assert.deepEqual(out.warnings, []);
});
