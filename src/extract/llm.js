/**
 * Tier 5: semantic label matching with Claude — for labels the deterministic
 * tiers could not resolve.
 *
 * Three rules make this safe to put in a scraper:
 *   1. It only ever sees labels that tiers 1-4 failed on.
 *   2. It must return values **verbatim from the digest** we send, together
 *      with the snippet they came from. `verifyGrounding` rejects anything
 *      that is not actually present in the page text — so a hallucinated
 *      phone number cannot reach the output.
 *   3. Its confidence is capped below every deterministic tier, so a later
 *      structured-data hit always wins.
 */

import { containsText, squish } from '../util/text.js';
import { validate, normalizeForOutput } from './patterns.js';

export const LLM_CONFIDENCE_CAP = 0.6;

const SYSTEM_PROMPT = `You match requested field labels to values that appear in a web page extract.

Rules, in priority order:
1. Only return a value if it is literally present in the PAGE EXTRACT. Copy it character-for-character.
2. If the page extract does not contain the information, return null for that field. Never infer, complete, translate, reformat, or construct a value. A missing value is a correct answer; a plausible invented value is the worst possible answer.
3. The page may use different wording than the label ("Tel", "Call us", "Reach us on" all mean a phone number). Use that judgement to LOCATE the value, never to INVENT it.
4. For each field also return "snippet": the surrounding 3-15 words from the extract, copied verbatim, that prove the value is there.
5. For list fields, return an array of values, each present verbatim.
6. Do not use knowledge about this organisation from outside the extract.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The field key exactly as given in the request.' },
          value: {
            anyOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
              { type: 'null' },
            ],
            description: 'Value(s) copied verbatim from the extract, or null if absent.',
          },
          snippet: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Verbatim surrounding text proving the value is in the extract.',
          },
        },
        required: ['key', 'value', 'snippet'],
        additionalProperties: false,
      },
    },
  },
  required: ['fields'],
  additionalProperties: false,
};

/**
 * @param {object} args
 * @param {import('../extract/labels.js').FieldSpec[]} args.specs   unresolved fields only
 * @param {Array<{url: string, digest: string}>} args.pages
 * @param {object} [args.options]
 * @returns {Promise<{candidates: Record<string, object[]>, warnings: string[], errors: object[], usage: object|null}>}
 */
export async function resolveWithLlm({ specs, pages, options = {} }) {
  const warnings = [];
  const errors = [];
  /** @type {Record<string, object[]>} */
  const candidates = {};

  if (!specs.length) return { candidates, warnings, errors, usage: null };

  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
    warnings.push('LLM matching requested but no ANTHROPIC_API_KEY is set — skipped.');
    return { candidates, warnings, errors, usage: null };
  }

  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch (err) {
    warnings.push(`LLM matching unavailable (@anthropic-ai/sdk not installed): ${err.message}`);
    return { candidates, warnings, errors, usage: null };
  }

  const client = new Anthropic(apiKey ? { apiKey } : {});
  const model = options.model ?? process.env.LABEL_SCRAPER_MODEL ?? 'claude-opus-5';

  // One call, all leftover fields, all pages — cheaper and more accurate than
  // per-field calls, because the model can tell competing values apart.
  const digest = pages
    .map((p, i) => `--- PAGE ${i + 1}: ${p.url} ---\n${p.digest}`)
    .join('\n\n');

  const fieldList = specs
    .map((s) => `- key: ${s.key} | label: "${s.label}" | expected kind: ${s.type}${s.plural ? ' (list of values)' : ''}`)
    .join('\n');

  const userContent = `FIELDS TO FIND:\n${fieldList}\n\nPAGE EXTRACT:\n${digest}`;

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
      },
      messages: [{ role: 'user', content: userContent }],
    });
  } catch (err) {
    errors.push({ type: 'llm_error', message: `Claude request failed: ${err.message}` });
    return { candidates, warnings, errors, usage: null };
  }

  if (response.stop_reason === 'refusal') {
    warnings.push('LLM declined to process this page extract; deterministic results only.');
    return { candidates, warnings, errors, usage: response.usage ?? null };
  }

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnings.push('LLM returned unparseable output; ignored.');
    return { candidates, warnings, errors, usage: response.usage ?? null };
  }

  const specByKey = new Map(specs.map((s) => [s.key, s]));
  const groundingText = digest;

  for (const field of parsed.fields ?? []) {
    const spec = specByKey.get(field.key);
    if (!spec) continue;
    if (field.value == null) continue;

    const values = Array.isArray(field.value) ? field.value : [field.value];
    for (const rawValue of values) {
      const value = squish(rawValue);
      if (!value) continue;

      const grounded = verifyGrounding({ value, snippet: field.snippet, haystack: groundingText });
      if (!grounded.ok) {
        warnings.push(
          `LLM value for "${spec.label}" rejected: ${grounded.reason} (value: ${JSON.stringify(value.slice(0, 60))})`,
        );
        continue;
      }

      const normalized = normalizeForOutput(spec.type, value);
      if (!validate(spec.type, normalized, { context: field.snippet ?? '' })) {
        warnings.push(`LLM value for "${spec.label}" failed ${spec.type} validation; discarded.`);
        continue;
      }

      const sourceUrl = attributeSource(value, pages) ?? pages[0]?.url ?? null;
      (candidates[spec.key] ??= []).push({
        value: normalized,
        confidence: LLM_CONFIDENCE_CAP,
        method: `llm:${model}`,
        selector: null,
        sourceUrl,
        snippet: squish(field.snippet ?? '').slice(0, 200),
      });
    }
  }

  return { candidates, warnings, errors, usage: response.usage ?? null };
}

/**
 * Reject any value that is not verbatim in the text we supplied.
 *
 * Whitespace and punctuation-run differences are tolerated (the digest
 * collapses whitespace, and the model may drop a stray separator), but the
 * alphanumeric content must be present.
 */
export function verifyGrounding({ value, snippet, haystack }) {
  if (!value) return { ok: false, reason: 'empty value' };
  if (containsText(haystack, value)) return { ok: true };

  // Loosened comparison: alphanumerics only.
  const strip = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const strippedValue = strip(value);
  if (strippedValue.length >= 3 && strip(haystack).includes(strippedValue)) {
    return { ok: true };
  }

  if (snippet && !containsText(haystack, snippet)) {
    return { ok: false, reason: 'neither the value nor its claimed snippet appears in the page extract' };
  }
  return { ok: false, reason: 'value is not present verbatim in the page extract' };
}

/** Which page did this value come from? Used for source_url provenance. */
function attributeSource(value, pages) {
  for (const p of pages) {
    if (containsText(p.digest, value)) return p.url;
  }
  return null;
}
