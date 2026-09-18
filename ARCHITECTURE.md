# Label-Driven Scraping Engine — Architecture

## 1. Problem statement

Input: one URL + an arbitrary, user-defined list of human labels
(`Hotel Name`, `Phone Number`, `Gallery Images`, `CEO Name`, `Latitude`, …).
Output: structured JSON, one entry per label, with provenance, `null` where
not found, and never a guess.

The hard part is not fetching — it is **mapping an open set of human labels
onto an open set of page structures** without hard-coding a vertical.

## 2. Core design decision: a deterministic cascade, LLM last

Every label is resolved by a **cascade of extractors ordered by trustworthiness**.
The first extractor that yields a value passing type validation with sufficient
confidence wins. The LLM is tier 5 and only sees labels that tiers 1–4 failed on.

| Tier | Source | Trust | Example |
|---|---|---|---|
| 1 | JSON-LD / Schema.org / microdata | 0.95 | `LodgingBusiness.telephone` |
| 2 | Open Graph + `<meta>` + `<link rel>` | 0.85 | `og:image`, `og:title` |
| 3 | Semantic HTML & attributes | 0.80 | `a[href^=tel:]`, `<address>`, `[itemprop=streetAddress]`, `<time datetime>` |
| 4 | Label-proximity DOM search | 0.45–0.75 | `<dt>Tel</dt><dd>+95…</dd>`, `.contact-phone`, text after a matching heading |
| 5 | LLM semantic matching (optional) | 0.60 cap | "Call us on oh-nine-five…" → phone |

**Why this order.** Tiers 1–3 are cheap, fast, deterministic and reproducible.
On a typical hotel or local-business site they resolve 60–80% of common labels.
The LLM is the expensive, non-deterministic tier, so it runs on a *condensed*
page digest for *only* the unresolved labels — typically 0–3 labels, one call.

Reproducibility matters for a scraper (re-running must give the same answer),
so the LLM is opt-in (`ANTHROPIC_API_KEY` + `useLlm: true`) and its confidence
is capped below the deterministic tiers, so it can never override a
structured-data hit.

## 3. Label understanding

A label becomes a **field spec** in `src/extract/labels.js`:

```
"Phone Number" -> {
  key: "phone_number",          // snake_case output key
  type: "phone",                // picks resolvers + validator
  plural: false,                // scalar vs array output
  keywords: ["phone","tel","telephone","mobile","contact","call","whatsapp", ...],
  schemaKeys: ["telephone","phone"],
  attrHints: ["tel","phone","contact"]
}
```

Two matching mechanisms, in order:

1. **Ontology lookup** (`src/extract/ontology.js`) — ~30 entries covering the
   common web-data value kinds (name, description, address, phone, email, url,
   price, image, image list, social profile, geo, hours, rating, person, sku,
   list-of-features …). Matched by exact alias, then token overlap, then
   substring, then trigram similarity ≥ 0.55.
2. **Heuristic inference** for labels the ontology has never seen
   (`Menu Image`, `Founder`, `Warranty Period`). The *head noun* decides the
   type (`… Image` → image, `… Images/Gallery/Photos` → image list,
   `… Price/Cost/Fee` → price, `… Email` → email), and the label's own tokens
   become the DOM and JSON-LD search keywords. This is what makes the engine
   genuinely generic rather than a hotel scraper with extra fields.

Pluralisation (`Images`, `Amenities`, `Room Types`) is detected from the label
and forces array output — so `Gallery Images` yields a deduped array while
`Main Image` yields one string, from the same underlying image harvest.

## 4. Pipeline

```
user input (url, labels[], options)
  |
  |- 1. validate & normalise URL          src/util/url.js
  |- 2. build field specs from labels     src/extract/labels.js
  |- 3. robots.txt gate (per origin)      src/core/robots.js
  |- 4. fetch page (static HTTP)          src/core/fetcher.js
  |- 5. decide: does this page need JS?   src/core/renderer.js   <- heuristic, 6.1
  |      \- if yes, re-render in Chromium (auto-scroll -> lazy images load)
  |- 6. build PageModel                   src/core/page.js
  |      (jsonld, microdata, meta/OG, images, links, visible text blocks)
  |- 7. resolve every field on this page   src/extract/resolvers.js
  |- 8. unresolved fields remain?
  |      \- score internal links against those fields' keywords
  |         src/links/discovery.js -> visit top-N (default 4), back to step 4
  |- 9. LLM pass for still-unresolved      src/extract/llm.js  (optional)
  |- 10. validate, normalise, dedupe       src/output/normalize.js
  \- 11. assemble result + status          src/output/result.js
```

Steps 4–8 form a **budgeted loop**: it stops as soon as all fields are
resolved, or when the page budget (`maxPages`) is spent — never a full crawl.

## 4b. Two page shapes, two modes

A page is either **one subject** (a hotel's own site: one record) or **a list**
(a directory, category or results page: one record per row). The cascade in §2
answers the first question. Run it on the second and you get the site's own
`og:image`, its `<title>` and a footer address — once — which looks like a
result and is not one.

`mode: 'auto'` (default) tries list extraction first and falls back to single.

**Finding the repeating block** (`src/extract/records.js`) — no site-specific
selectors, nothing to configure:

1. **Signature grouping.** For every element, bucket its element children by a
   structural fingerprint: tag + class list with digits stripped (`item-1` and
   `item-2` collapse) + child-tag sequence. Buckets repeating ≥ 3 times with
   real text are candidates.
2. **Score by yield.** Sample up to four members of each candidate, build a
   scope model for each, and count how many of the *requested* labels resolve.
   A candidate must average `minFieldsPerRecord` (default 2). This is what
   rejects a sidebar's ten category links — they yield one field at best — and
   selects the listing cards.
3. **Tie-break on count, then depth.** Grids nest (rows of three cards), so both
   the row group and the card group resolve every field. More items at the same
   yield means the finer grouping: one record per card, not per row.
4. **Extract per item.** Each member becomes its own `PageModel` via
   `buildScopeModel`, and the §2 cascade runs inside it.

**Why scope models rather than a root-selector parameter.** `buildScopeModel`
re-parses the element's own HTML. That keeps one code path for pages and
records, and — more importantly — it makes metadata leakage *structurally*
impossible: a record has no `<meta>`, no page JSON-LD and no footer in scope, so
`og:image` cannot become a listing's photo. A filter could be forgotten; an
empty scope cannot.

**Type-directed fallbacks, allowed only here.** Inside a record, after the
label-driven cascade comes "the thing in this element that validates as an X":
the block that passes `validateAddress`, the `tel:` link, the only image. Across
a whole page that is a reckless guess — footer, testimonial and nav blob all
compete. Inside one 200-character card there is one address, and the type
validator is strong evidence. This is what extracts unlabelled addresses and
phone numbers from cards whose markup carries no label text at all.

Records that yield nothing are dropped, which removes the advert slots that
share the cards' signature. `field_coverage` reports each label's fill rate
across records, distinguishing "the site doesn't publish this" from "my label
missed".

## 5. Output contract

```jsonc
{
  "url": "https://example-hotel.com",
  "status": "ok" | "partial" | "error",
  "fetched_at": "2026-09-16T12:00:00.000Z",
  "data": {                       // flat values — the shape in the brief
    "hotel_name": "ABC Hotel",
    "phone_number": null,
    "gallery_images": ["https://…/1.jpg"]
  },
  "fields": {                     // same values + provenance
    "hotel_name": {
      "label": "Hotel Name",
      "value": "ABC Hotel",
      "source_url": "https://example-hotel.com/",
      "method": "jsonld:Hotel.name",
      "selector": null,
      "confidence": 0.95
    }
  },
  "missing_fields": ["Phone Number"],
  "pages_visited": [{ "url": "…", "renderer": "playwright", "status": 200 }],
  "errors": [],
  "warnings": []
}
```

`data` satisfies the requested example format; `fields` satisfies the
"keep the source URL" requirement. Both are always present, so callers pick.

`status`: `ok` = every field resolved; `partial` = at least one resolved;
`error` = nothing fetched (bad URL, robots block, timeout, all pages failed).

## 6. Known failure modes and the designed answer to each

### 6.1 JavaScript-rendered pages

**Problem.** Static HTML is an empty `<div id="root">`, so a naive scraper
returns nulls. But rendering every page in Chromium costs ~1–3 s and a few
hundred MB, so rendering cannot be the default either.

**Solution — a render-necessity heuristic** (`renderer.needsRendering`).
Render only if any of these hold:

- visible text < 500 chars, or text-to-HTML byte ratio < 0.06;
- an empty SPA mount point (`#root`, `#app`, `[data-reactroot]`, `#__next`)
  with no element children;
- `<noscript>` contains "enable JavaScript";
- zero `<img>` elements but many `data-src` / `data-lazy` attributes;
- **or** the first deterministic pass left required fields unresolved
  (retry-with-render).

That last condition is the important one: the decision is driven by *whether we
actually got the data*, not by guessing which framework built the page.

**Waiting correctly.** `domcontentloaded` → `networkidle` (capped) → a
stable-DOM settle (two consecutive equal `document.body.innerHTML.length`
samples), then auto-scroll to the bottom in steps to trigger lazy loaders and
`IntersectionObserver` galleries, then one final settle. There is a hard
per-page timeout, and on timeout we keep whatever HTML exists rather than
discarding the page.

### 6.2 Image extraction

**Problems.** `src` may be a 1×1 placeholder or a base64 blur-up; the real URL
hides in `data-src` / `data-original` / `data-lazy-src`; `srcset` holds many
resolutions; `<picture>` has competing `<source>` elements; CSS
`background-image` holds hero images; tracking pixels, sprites, icons and logos
pollute the list; and the same image appears under several CDN transform URLs.

**Solutions** (`src/extract/images.js`):

- Harvest from every channel: `src`, `srcset`/`sizes`, `<source srcset>`,
  `data-src|data-original|data-lazy|data-lazy-src|data-bg|data-image|data-large|data-zoom-image`,
  inline `style="background-image:url(...)"`, `og:image` / `twitter:image`,
  `<link rel=image_src>`, and JSON-LD `image` / `ImageObject.contentUrl` /
  `thumbnailUrl`.
- **Highest quality wins**: parse `srcset` and keep the largest `w`/`x`
  descriptor; prefer explicit `width`/`height` attributes; prefer a `data-*`
  full-size URL over the `src` thumbnail on the same element.
- **Junk filter**: drop `data:` URIs, SVG sprites, 1×1 images, declared sizes
  under 100 px, and URLs matching
  `/(sprite|icon|favicon|pixel|tracking|placeholder|blank|loader|spinner)/i`.
- **Dedupe by identity, not by string**: normalise the URL (drop `?w=`, `?h=`,
  `?quality=`, `?format=`, fragments, protocol-relative prefix) and key on the
  normalised form plus basename, so `photo.jpg?w=400` and `photo.jpg?w=1600`
  collapse to one entry — keeping the larger.
- **Main vs gallery**: `main_image` prefers `og:image` → JSON-LD primary image →
  largest image early in the document; `gallery_images` takes the remainder in
  document order, with the main image excluded.
- Always absolutised against the page's `<base href>` or the final URL after
  redirects.

### 6.3 Internal-link crawling

**Problem.** "Follow relevant pages" degenerates into crawling the whole site —
or misses `/contact` because the link text is an icon.

**Solutions** (`src/links/discovery.js`):

- Runs only for **unresolved** fields, and scores each same-origin link by
  overlap of `href` path tokens, anchor text, and `title` / `aria-label`
  against those fields' keywords, plus a small prior for universally useful
  paths (`contact`, `about`, `rooms`, `gallery`, `location`, `menu`, `pricing`).
- Hard caps: `maxPages` (default 5 total), depth 1 by default, same registrable
  domain only, one visit per normalised URL.
- Skips non-HTML extensions, `mailto:` / `tel:` / `javascript:`, query-heavy
  pagination and filter URLs (`?page=`, `?sort=`, `?filter=`), and anything
  robots.txt disallows.
- Stops the moment every field is resolved — the common case is one extra page.

### 6.4 Pagination

**Problem.** A long list is split two structurally different ways, and both must
be walked to completion without turning into an unbounded crawl:
numbered pages (`?page=2`, `/page/3/`, "Next ›") and in-place appending
(infinite scroll, "Load more").

**Solution — numbered pagination** (`links/discovery.js → discoverNextPage`).
Four strategies, strongest first:

1. `rel="next"`, on an `<a>` or in `<head>`.
2. **Numbered**: parse the page number out of the current URL (`?page=`,
   `?paged=`, `?p=`, `/page/N/`, `-page-N`) and find the link to *N+1*. This is
   the load-bearing one — a great many sites render `1 2 3 … ›` where the Next
   control is an icon with no text, so text matching stalls on page 1. Knowing
   where we are makes the control's labelling irrelevant.
3. A next-ish control by text / `aria-label` / `title` / class, excluding
   anything `disabled` and never matching a "previous" control.
4. Offset pagination (`?start=40`), stepping by the stride visible on the page.

The walk is a loop with **explicit, reported termination**
(`pagination.stopped_because`): the last page, the page budget, `maxRecords`, a
page with no rows, a page whose rows were all already collected, or a next link
pointing at a URL already visited (a pagination loop). Rows are deduped globally
across pages and each keeps the `_source_url` it came from. The budget is
deliberately *not* `maxPages` — that option governs link-following breadth in
single mode, and silently clipping a 40-page walk to 5 because of an unrelated
default would be a trap. `maxRecords` plus a 500-page hard cap are the limits.

**Solution — infinite scroll** (`core/renderer.js → exhaustiveScroll`). The
capped `autoScroll` used for lazy images is the wrong tool here: there, page
length is known and the goal is triggering `IntersectionObserver`; here the
length is unknown and each scroll may fetch another batch. So `exhaustScroll`
is driven by *observed growth*, bounded by wall-clock time rather than a step
count, and run step-by-step from Node so a hung in-page fetch cannot exceed the
budget.

It **alternates** scrolling with clicking "load more", because they are usually
the same list: scrolling reveals the button, the button appends rows, which
makes the page scrollable again. Either alone under-collects. A click that does
not grow the DOM ends the loop immediately, so a button still present after the
list is exhausted cannot spin to the cap.

The two compose: with both enabled, each page is scrolled to exhaustion before
its pagination link is followed. `exhaustScroll` also forces a render even when
static extraction already produced rows — the static HTML holds the first batch
only, so "we already got records" is not evidence there are no more.

### 6.5 Rate limiting and politeness

**Problem.** Parallel fetches against one host look like an attack and get you
blocked.

**Solution** (`src/core/fetcher.js`): a **per-host serial queue** — concurrency
1 per host, `minDelayMs` (default 1200 ms) plus jitter between requests,
honouring robots.txt `Crawl-delay` when it is larger. Global concurrency across
*different* hosts is capped separately. Retries happen only on 408/429/5xx and
network errors, with exponential backoff and `Retry-After` respected; three
attempts, then give up. A descriptive User-Agent and `Accept-Language` are set.
No proxy rotation and no UA spoofing to defeat blocks.

### 6.6 Data accuracy — never inventing values

**Problem.** The single biggest failure mode is returning a plausible-looking
wrong value: a phone number scraped from a footer ad, a price from a different
room, an LLM hallucinating a well-formed address.

**Solutions:**

- **Type validators gate every candidate** (`src/extract/patterns.js`): phones
  must survive digit-count checks (7–15 digits, E.164-ish) and are rejected if
  they look like a date, a price, a postcode or a tracking id; emails must pass
  a strict regex and not be `example.com` / `sentry` / `@2x.png`; lat/lng must
  be numeric and in range; URLs must parse as http(s); prices must contain a
  currency marker or a currency-shaped number.
- **Confidence floor** (`minConfidence`, default 0.4): a candidate below it is
  discarded and the field becomes `null`.
- **Anti-boilerplate check**: candidates whose value also appears inside
  `<nav>` / `<footer>` on multiple pages score lower for page-specific fields,
  so a footer phone does not outrank the contact page's phone.
- **The LLM is grounded and verified**: it receives a text digest plus the
  candidate pool, and must return values **verbatim from the digest** along with
  the snippet they came from. Any returned value that is not a substring of the
  digest is rejected in code. It is instructed — and post-checked — to return
  `null` rather than guess.
- **Provenance on every value**: `source_url`, `method`, `selector`,
  `confidence`, so a wrong answer is auditable rather than mysterious.
- Unresolved is a first-class outcome: `null` plus the label listed in
  `missing_fields`.

### 6.7 Access restrictions

robots.txt is fetched, cached per origin, and enforced (`obeyRobots: true` by
default; turning it off is the operator's decision and is recorded in
`warnings`). CAPTCHA, login walls, paywalls and anti-bot interstitials are
**detected and reported, never circumvented**: the page classifier looks for
CAPTCHA markers (`recaptcha`, `hcaptcha`, `cf-challenge`, "Just a moment…"),
login forms (`input[type=password]`), and 401/403/429 responses, then emits a
typed error (`captcha` / `login_required` / `blocked` / `robots_disallowed`) so
the caller gets `status: "partial"` with an explanation instead of a crash or a
bypass attempt.

## 7. Folder structure

```
package.json
ARCHITECTURE.md
README.md
src/
  cli.js                  CLI entry (url + labels -> JSON/CSV on stdout or file)
  server.js               Express API + static UI
  index.js                library entry: export { scrape }
  core/
    pipeline.js           the orchestrator (section 4)
    fetcher.js            per-host rate-limited HTTP with retries
    renderer.js           Playwright rendering, settle + auto-scroll + load-more
    robots.js             robots.txt cache and gate
    page.js               PageModel builder
    guards.js             CAPTCHA / login / block detection
  extract/
    ontology.js           label -> value-kind knowledge base
    labels.js             label parsing, matching, key generation
    structured.js         JSON-LD / microdata / OG / meta extraction
    images.js             image harvesting, quality ranking, dedupe
    patterns.js           regexes + validators + normalisers per value kind
    resolvers.js          the tier 1-4 cascade per value kind
    llm.js                tier 5: grounded Claude call for leftovers
  links/
    discovery.js          relevance-scored internal link selection + pagination
  sources/
    googlePlaces.js       Google Places API source (not a Maps scrape)
  output/
    normalize.js          whitespace/url/phone normalisation, dedupe
    result.js             result assembly, status, missing_fields
    exporters.js          JSON + CSV serialisation
  util/
    url.js  text.js  logger.js  queue.js
public/
  index.html ui.js styles.css      the UI
test/
  *.test.js  fixtures/
```

## 8. Database schema (optional)

The engine is **stateless** and no database is required; the default build ships
without one. Persistence earns its place only for job history, caching, and
re-running the same extraction over time. Recommended minimal SQLite/Postgres
schema:

```sql
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,          -- uuid
  url           TEXT NOT NULL,
  labels        TEXT NOT NULL,             -- JSON array of the user's labels
  options       TEXT,                      -- JSON snapshot of options used
  status        TEXT NOT NULL,             -- queued|running|ok|partial|error
  started_at    TIMESTAMP,
  finished_at   TIMESTAMP,
  error         TEXT
);

CREATE TABLE job_pages (                   -- what we actually visited, for audit
  id            INTEGER PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  final_url     TEXT,
  http_status   INTEGER,
  renderer      TEXT,                      -- static|playwright
  fetched_at    TIMESTAMP,
  content_hash  TEXT                       -- sha256 of HTML, for change detection
);

CREATE TABLE job_fields (                  -- one row per requested label
  id            INTEGER PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,             -- as the user typed it
  field_key     TEXT NOT NULL,             -- snake_case
  value_type    TEXT NOT NULL,             -- phone|image|text|...
  value         TEXT,                      -- JSON (string or array); NULL if not found
  source_url    TEXT,
  method        TEXT,
  selector      TEXT,
  confidence    REAL,
  UNIQUE (job_id, field_key)
);

CREATE TABLE http_cache (                  -- politeness: don't refetch within TTL
  url_hash      TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  html          TEXT,
  http_status   INTEGER,
  renderer      TEXT,
  fetched_at    TIMESTAMP NOT NULL
);

CREATE INDEX idx_jobs_url ON jobs (url);
CREATE INDEX idx_job_fields_job ON job_fields (job_id);
CREATE INDEX idx_http_cache_fetched ON http_cache (fetched_at);
```

`job_fields` being one row per label — rather than a wide table — is what keeps
the schema label-agnostic, for the same reason the engine itself has no field
constants.

## 9. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node.js 20** | Already installed here (Python is not on PATH); Playwright's first-class language; one language for engine and UI |
| Browser rendering | **Playwright** (Chromium) | Better auto-waiting than Puppeteer; `route()` lets us block images/fonts/analytics for speed; solid Windows support |
| HTML parsing | **Cheerio** | jQuery-style selectors over a fast htmlparser2 tree, without DOM overhead |
| HTTP | **native `fetch`** (Node 20) | No dependency; redirects and `AbortSignal.timeout` built in |
| robots.txt | **robots-parser** | Correct group and Crawl-delay semantics, which are easy to get subtly wrong by hand |
| Structured data | hand-rolled JSON-LD + microdata walker | Schema.org shapes are irregular (`@graph`, arrays, nested refs); a generic flattener beats a strict typed parser here |
| Semantic fallback | **Claude via `@anthropic-ai/sdk`** (`claude-opus-5`, structured outputs) | Tier 5 only, only for leftover labels, grounded against a digest and verified in code |
| UI | Express + vanilla HTML/JS | The UI needs a server-side browser anyway, and zero build step keeps it inspectable |
| Tests | `node --test` | Built in; fixtures are local HTML files, so tests never hit the network |
