# Label Scraper

Give it a URL and a list of field labels. It looks for those fields, returns
structured JSON with the source of every value — and returns `null` rather than
guessing when it cannot find something.

It is a **generic engine, not a hotel scraper**: no field is hard-coded. `Hotel
Name`, `CEO Name`, `Latitude`, `Menu Image`, `Warranty Period` and
`Flurb Coefficient` all go through the same code path.

```bash
npm install
npx playwright install chromium     # only needed for JavaScript-built sites
npm start                           # UI on http://localhost:3000
```

Design rationale, the failure modes it is built around, and the optional
database schema are in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Three ways to use it

### 1. Web UI

```bash
npm start           # http://localhost:3000
```

Enter a URL, add labels (presets for hotel / local business / product are one
click), press **Start Scraping**. Results show one row per label with the value,
the page it came from, how it was found, and a confidence score. Export as JSON
or CSV.

### 2. CLI

```bash
node src/cli.js --url https://example-hotel.com \
  --labels "Hotel Name,Address,Phone Number,Email,Description,Room Type,Price,Amenities,Main Image,Gallery Images"

node src/cli.js --url https://example.com --labels-file labels.txt --csv --out result.csv
```

`node src/cli.js --help` lists every flag. Exit code is `0` when every label was
found, `2` when some were missing, `1` on error — so it composes in a shell
pipeline.

### 3. Library

```js
import { scrape } from './src/index.js';

const result = await scrape({
  url: 'https://example-hotel.com',
  labels: ['Hotel Name', 'Phone Number', 'Gallery Images'],
  options: { maxPages: 5, render: 'auto', useLlm: false },
});
```

For many URLs in one process, pass a shared `Renderer` so they reuse one
Chromium instance:

```js
import { scrape, Renderer } from './src/index.js';

const renderer = new Renderer();
try {
  for (const url of urls) {
    const result = await scrape({ url, labels, renderer });
  }
} finally {
  await renderer.close();
}
```

---

## Two page shapes: one subject, or a list

Pages ask different questions, so the engine has two modes and picks between
them automatically (`mode: 'auto'`).

**A subject page** — a hotel's own site — has one record: *this hotel*.

**A listing page** — a directory, category or search-results page — has many:
one per row. Running subject-mode extraction on a directory is the classic
failure: you get the site's own logo, its `<title>`, and a footer address, once.
List mode instead finds the repeating block and extracts **inside each item**.

```bash
node src/cli.js --url "https://example-pages.biz/topsearch/83/Beauty%20Salons" \
  --labels "Name,Category,Address,Phone Number,Image" --mode list --csv
```

```csv
name,category,address,phone_number,image,source_url
2 Lady,Beauty Salons and Spa,"No.75, 12st, Lanmadaw.Tsp, Yangon",09-421116317,https://…/2lady.jpg,https://…
808 Beauty Center,Beauty Salons and Spa,"310, Cor. of Anawrahta Rd. …",09-420012888,https://…/808.jpg,https://…
```

How the repeating block is found — no site-specific selectors, and nothing to
configure:

1. Group every element's children by **structural signature** (tag, its class
   list with digits stripped, its child-tag sequence). Buckets that repeat three
   or more times are candidates. A sidebar's ten category links is a candidate;
   so is the results column.
2. Score each candidate by **how many of your labels its members actually
   yield**. A candidate must average at least two. That is what rejects the
   sidebar links and picks the listing cards.
3. Tie-break on item count, then depth — so a grid of rows-of-three gives one
   record per card, not one per row.
4. Treat each item as its own tiny page and run the normal cascade inside it.

Two things make list mode accurate rather than merely plausible:

- **Records cannot see page-level metadata.** Each item is re-parsed on its own,
  so `og:image`, `og:title` and the footer are simply not in scope. That is
  structural, not a filter that might be forgotten.
- **Type-directed fallbacks are allowed here.** "The text in this element that
  validates as an address" is reckless across a whole page but reliable inside
  one 200-character card. Unlabelled addresses, phones and photos resolve
  without any label appearing in the markup.

`field_coverage` reports how many records filled each column, which is the fast
way to see whether a column is genuinely absent or your label missed:

```jsonc
"field_coverage": {
  "phone_number": { "label": "Phone Number", "found_in": 18, "of": 20, "percent": 90 }
}
```

Set `--mode single` to force subject extraction on a page that happens to have
repeating blocks, or `--mode list` to get an explicit "this page has no list"
answer instead of a silent fallback.

## Getting *all* the rows off a paginated list

Two different mechanisms, because sites split long lists two different ways.

### Numbered pagination — `?page=2`, `/page/3/`, "Next ›"

```bash
# every page, until it runs out
node src/cli.js --url "https://example-pages.biz/topsearch/83/Beauty" \
  --labels "Name,Category,Address,Phone Number,Image" --all-pages --csv --out all.csv

# or a fixed budget
node src/cli.js --url "…" --labels "…" --pagination --max-pagination-pages 10
```

Finding the next page is deliberately not text matching. In order:

1. `rel="next"` on an `<a>` or in `<head>`.
2. **Numbered:** read the page number out of the current URL (`?page=`, `?paged=`,
   `?p=`, `/page/N/`, `-page-N`) and look for the link to *N+1*. This is the one
   that carries most real sites — plenty render `1 2 3 … ›` where the Next
   control is an icon with **no text at all**, which stalls text matching on
   page 1.
3. A next-ish control by text, `aria-label`, `title` or class — skipping
   anything marked `disabled`, and never matching "previous".
4. Offset pagination (`?start=40`), stepping by the stride found on the page.

The walk stops, and tells you which of these happened, in `pagination.stopped_because`:

```jsonc
"pagination": {
  "enabled": true, "pages_walked": 3, "page_budget": 3, "scrolled": false,
  "stopped_because": "reached the last page (no further \"next\" link)"
}
```

Other stop reasons: the page budget, `maxRecords`, a page with no rows, a page
that repeated rows already collected, or a next link pointing back at a page
already visited (a pagination loop). Rows are deduped across pages, and each
record keeps the `_source_url` of the page it actually came from.

**This costs one request per page**, paced by the per-host delay — 40 pages at
the 1200 ms default is about a minute. `--all-pages` is bounded by `--max-records`
(default 200) and a hard 500-page cap, so it cannot run away.

### Infinite scroll and "Load more"

No page links; rows append to the same DOM as you scroll.

```bash
node src/cli.js --url "https://example.com/listings" \
  --labels "Name,Price,Image" --scroll-all --csv
```

`--scroll-all` renders the page and then **alternates** scrolling to the bottom
with clicking "load more", until neither does anything:

- scroll to the bottom, wait, measure `scrollHeight`; repeat while it grows
- when growth stops, look for a load-more control and click it
- if that added DOM, go back to scrolling

Both halves are needed, because they are usually the same list: scrolling
reveals the button, the button appends rows, which makes the page scrollable
again. It is bounded by `--scroll-budget` (45 s per page), `--max-load-more`
(3 clicks) and a stop-on-no-growth check, so an endlessly-generating feed
terminates. The result reports what happened:

```
exhaustive scroll: 8 scroll round(s), 1 "load more" click(s) — stopped because no further growth
```

A click that adds nothing ends the loop immediately, so a button that stays on
the page after the list is exhausted cannot spin to the cap.

You can combine both: `--all-pages --scroll-all` scrolls each page fully, then
follows the pagination to the next one.

## Output

### List mode

```jsonc
{
  "url": "https://example-pages.biz/topsearch/83/Beauty%20Salons",
  "mode": "list",
  "status": "ok",
  "record_count": 4,
  "records": [
    {
      "name": "2 Lady",
      "category": "Beauty Salons and Spa",
      "address": "No.75, 12st, Lanmadaw.Tsp, Yangon",
      "phone_number": "09-421116317",
      "image": "https://…/images/company/2lady.jpg",
      "_source_url": "https://…"
    }
  ],
  "record_fields": [ /* per-record provenance, same order as `records` */ ],
  "field_coverage": { /* per-label fill rate */ },
  "list_container": { "selector": "main.results", "items_detected": 5 },
  "missing_fields": [],
  "pages_visited": [{ "url": "…", "records_found": 4 }]
}
```

`records` is a clean array of plain objects — no provenance interleaved — so it
drops straight into a database or a spreadsheet. Provenance lives in
`record_fields` at the same index.

### Single mode

```jsonc
{
  "url": "https://example-hotel.com",
  "status": "ok",                  // ok | partial | error
  "fetched_at": "2026-09-16T09:12:04.812Z",

  "data": {                        // flat values — the simple shape
    "hotel_name": "Shwe Pyi Hotel",
    "phone_number": "+95 9 7712 3456",
    "email": null,
    "gallery_images": ["https://cdn.example/room-1.jpg"]
  },

  "fields": {                      // the same values, with provenance
    "phone_number": {
      "label": "Phone Number",
      "value": "+95 9 7712 3456",
      "source_url": "https://example-hotel.com/contact",
      "method": "a[href^=tel:]",
      "selector": "dd.contact-phone",
      "confidence": 0.8,
      "value_type": "phone",
      "found": true,
      "alternatives": [{ "value": "+95944556677", "confidence": 0.52, "method": "pattern match over page text" }]
    }
  },

  "missing_fields": ["Email"],
  "pages_visited": [
    { "url": "https://example-hotel.com/", "status": 200, "renderer": "static", "reasons": ["user-provided URL"] },
    { "url": "https://example-hotel.com/contact", "status": 200, "renderer": "static", "reasons": ["likely page for these fields (/contact)"] }
  ],
  "errors": [],
  "warnings": [],
  "stats": { "labels_requested": 4, "labels_found": 3, "pages_fetched": 2 }
}
```

- **`data`** is the plain shape for downstream code.
- **`fields`** answers "where did this come from, and how confident are you?".
- `status` is `ok` only when every requested label was found.
- A plural label (`Gallery Images`, `Amenities`, `Room Types`) returns an array;
  a singular one returns a scalar. `null` / `[]` means not found.

---

## How labels are matched

Labels do not need to match the page's wording. `Phone Number` will find `Tel`,
`Telephone`, `Call us`, `a[href^="tel:"]`, `LocalBusiness.telephone`, or a
number sitting under a "Contact" heading.

Each label is resolved by a cascade, best source first:

| Tier | Source | Typical confidence |
|---|---|---|
| 1 | JSON-LD / Schema.org / microdata | 0.88–0.95 |
| 2 | Open Graph, `<meta>`, `<link rel>` | 0.85 |
| 3 | Semantic HTML (`tel:`, `mailto:`, `<address>`, `itemprop`) | 0.80 |
| 4 | Label-proximity DOM search (`<dt>/<dd>`, tables, class names, headings) | 0.45–0.77 |
| 5 | Claude, grounded and verified — **optional, off by default** | 0.60 max |

Anything below `minConfidence` (default 0.4) is discarded and the field becomes
`null`. Tier 5 can never outrank a structured-data hit.

To see how your labels will be interpreted before running anything:

```bash
curl -s -X POST localhost:3000/api/labels/preview \
  -H 'Content-Type: application/json' \
  -d '{"labels":["Menu Image","CEO Name","Rates"]}'
```

---

## Accuracy: what stops it inventing values

This is the part most worth knowing about, because a plausible wrong value is
worse than a missing one.

- **Every candidate is type-validated.** Phones must pass digit-count and
  shape checks and are rejected if they look like a date, a price, a postcode or
  a registration number; emails must not be `@example.com` or an `@2x.png`
  filename; lat/lng must be in range; prices need a currency marker.
- **Roles are exclusive.** A value labelled "Practice Manager" is not an answer
  to "CEO Name", and a business's `name` is never an answer to a question about
  a person.
- **Distinct channels stay distinct.** "Fax" and "WhatsApp" do not collect the
  main phone number, and vice versa.
- **The LLM tier is grounded.** It must return values verbatim from the page
  digest it was given, plus the snippet they came from; anything not actually
  present in that text is rejected in code before it can reach the output.
- **Everything is attributable.** `source_url`, `method`, `selector` and
  `confidence` on every value, plus runner-up candidates — so a wrong answer is
  auditable rather than mysterious.

---

## JavaScript-rendered sites

Rendering is `auto` by default: a static fetch happens first, and Chromium is
used only when it is actually needed — an empty SPA mount point, near-zero
visible text, lazy-only images, **or** requested fields that the static HTML
could not answer. When it renders, it waits for network idle, waits for the DOM
to stop changing, then auto-scrolls in steps to trigger lazy loaders and
`IntersectionObserver` galleries.

```bash
node src/cli.js --url https://spa-site.example --labels "Name,Price" --render always
node src/cli.js --url https://gallery-site.example --labels "Gallery Images" --load-more
```

If `playwright install chromium` has not been run, the engine says so in
`warnings` and continues with static HTML rather than failing.

---

## Optional: the AI fallback

Off by default. When enabled, one Claude call handles **only** the labels that
tiers 1–4 could not resolve.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node src/cli.js --url https://example.com --labels "Founder,Warranty Period" --llm
```

Uses `claude-opus-5` with structured outputs at low effort; override with
`--llm-model` or `LABEL_SCRAPER_MODEL`. Without a credential the run continues
deterministically and records a warning.

---

## Scraping conduct

- **robots.txt is fetched, cached per origin and obeyed**, including
  `Crawl-delay`. Disallowed URLs are skipped and reported as
  `robots_disallowed`. The CLI's `--ignore-robots` exists for sites you own; the
  web UI cannot disable it.
- **One request at a time per host**, with a minimum delay (default 1200 ms)
  plus jitter. Retries only on 408/429/5xx, honouring `Retry-After`.
- **CAPTCHA, login walls, paywalls and anti-bot interstitials are detected and
  reported, never circumvented** — you get `status: "partial"` with a typed
  error saying what blocked it.
- **No whole-site crawling.** Internal links are followed only when a requested
  field is still unresolved and the link's path or text suggests it holds that
  field, capped by `maxPages` (default 5) at depth 1.
- A descriptive User-Agent is sent. No proxy rotation, no UA spoofing to defeat
  blocks.

You are responsible for having the right to extract from a given site.

---

## Options

| Option (library) | CLI flag | Default | What it does |
|---|---|---|---|
| `mode` | `--mode` | `auto` | `auto` / `list` (one record per item) / `single` (one record per page) |
| `maxRecords` | `--max-records` | 200 | Cap on records in list mode |
| `minFieldsPerRecord` | — | 2 | Labels a repeating block must average before it counts as the list |
| `maxPages` | `--max-pages` | 5 | Total page budget, including the first |
| `maxDepth` | — | 1 | Link-following depth |
| `followInternalLinks` | `--no-follow` | true | Follow relevant internal pages |
| `allowPagination` | `--pagination` / `--all-pages` | false | Walk `?page=N` / "Next" and concatenate records |
| `maxPaginationPages` | `--max-pagination-pages` | 2 | Extra list pages; `all` = until exhausted (500 hard cap) |
| `exhaustScroll` | `--scroll-all` | false | Infinite scroll: scroll + click "load more" until no growth |
| `maxLoadMoreClicks` | `--max-load-more` | 3 | Cap on "load more" clicks per page |
| `scrollBudgetMs` | `--scroll-budget` | 45000 | Time budget for scrolling one page |
| `render` | `--render` | `auto` | `auto` / `always` / `never` |
| `clickLoadMore` | `--load-more` | false | Click bounded "load more" buttons |
| `useLlm` | `--llm` | false | Enable the Claude fallback |
| `llmModel` | `--llm-model` | `claude-opus-5` | Model for the fallback |
| `minConfidence` | `--min-confidence` | 0.4 | Below this, a field is `null` |
| `maxListItems` | — | 40 | Cap on items in a list field |
| `minDelayMs` | `--delay` | 1200 | Minimum gap between requests to one host |
| `requestTimeoutMs` | `--timeout` | 20000 | Per-request timeout |
| `obeyRobots` | `--ignore-robots` | true | Consult robots.txt |
| `logLevel` | `--verbose` | `silent` | Progress logging on stderr |

Server env vars: `PORT` (3000), `MAX_CONCURRENT_SCRAPES` (2),
`RENDER_TIMEOUT_MS` (30000), `ANTHROPIC_API_KEY`.

---

## HTTP API

| Endpoint | Purpose |
|---|---|
| `POST /api/scrape` | `{ url, labels[], options? }` → the result object |
| `POST /api/labels/preview` | `{ labels[] }` → how each label will be interpreted |
| `GET /api/export/:id.json` / `.csv` | Download a recent result |
| `GET /api/health` | Renderer / LLM availability and defaults |

Results are held in memory (last 50) purely so exports can be downloaded; add
the schema in ARCHITECTURE.md §8 if you need persistence.

---

## Google Places (the "list from Google Maps" tab)

The UI has a second tab that returns businesses from Google — **through the
official Places API, not by scraping Maps.**

```bash
export GOOGLE_MAPS_API_KEY=...        # "Places API (New)" enabled on the project
npm start                             # the Google Places tab becomes usable
```

Type a query the way you would in Maps (`beauty salons in Yangon`), pick the
fields you want, and you get the same record table, coverage percentages and
JSON/CSV export as a scraped list.

### Why not scrape Maps directly

Worth being precise, because the usual objection is the wrong one:

- **robots.txt is not the blocker.** `google.com/robots.txt` says
  `Disallow: /maps/` but then `Allow: /maps/search/`, so the crawler would not
  refuse that path.
- **The Terms of Service are.** Google's ToS prohibit automated extraction of
  Maps content. robots.txt permitting a crawl path is not permission to harvest
  the data behind it.
- **And it would not work anyway.** Maps results are a virtualised JS panel
  fed by internal XHR, behind bot detection and consent interstitials. Making
  it work means building evasion, not extraction.

The API returns the same businesses as structured fields, which is both
permitted and better data than any scrape of that page would yield.

### Fields

Places has a **fixed** field set, unlike scraping a page where any label can
work. These map:

| Your label | Places field |
|---|---|
| Name | `displayName.text` |
| Address | `formattedAddress` |
| Phone Number | `nationalPhoneNumber` (falls back to international) |
| International Phone | `internationalPhoneNumber` |
| Website | `websiteUri` |
| Google Maps Link | `googleMapsUri` |
| Rating | `rating` |
| Reviews | `userRatingCount` |
| Latitude / Longitude | `location.latitude` / `.longitude` |
| Opening Hours | `regularOpeningHours.weekdayDescriptions` |
| Category | `primaryTypeDisplayName` (falls back to `types`) |
| Price | `priceLevel` |
| Business Status | `businessStatus` |
| Place ID | `id` |
| Photo / Photos | `photos` → resolved to image URLs |

A label with no Places equivalent (`Owner Email`, say) comes back `null` and is
named in `warnings` — it is not silently dropped.

### Cost and limits, which are Google's not mine

- **Every search is billed to your key**, and so is every photo URL resolved.
  The field mask is built from the labels you actually asked for, because
  Google prices by field group — asking for everything costs more.
- **60 results maximum** per text search (3 pages of 20). Asking for more is
  capped and reported in `warnings`.
- Photos need a second call each, so `maxPhotosPerPlace` defaults to **1** and
  photos are only fetched when a photo label is requested.
- Photo URLs are resolved server-side with `skipHttpRedirect=true`. The simpler
  media URL would work in an `<img>` tag but only by putting **your API key in
  a client-visible URL**, so it is not used.

An invalid key is reported as an auth problem with what to check — note that
Google returns **400**, not 403, for `API_KEY_INVALID`, so classifying on
status alone would send you off to inspect your field mask.

```bash
curl -s -X POST localhost:3000/api/places -H 'Content-Type: application/json' \
  -d '{"query":"beauty salons in Yangon","labels":["Name","Address","Phone Number","Rating"]}'
```

## Deploying

The engine runs in two shapes, and the difference matters.

| | Long-lived server | Serverless (Vercel) |
|---|---|---|
| Static extraction (JSON-LD, OG, semantic HTML, label proximity) | yes | **yes** |
| List records, numbered pagination | yes | **yes** |
| JavaScript-rendered pages | yes | **no** |
| Infinite scroll / "load more" | yes | **no** |
| Page budget · records · per-host delay | 5 · 200 · 1200 ms | 3 · 60 · 600 ms |

### Vercel

`vercel.json` and `api/index.js` are committed, so a push deploys. `api/index.js`
exports the Express app as a request handler; `src/server.js` only binds a port
when run directly.

**A serverless function cannot run Chromium and has a hard time limit**, so
`render` is forced to `never` there and the scroll options are refused with an
explanation rather than attempted — a browser launch would just burn the
60-second budget and fail. The UI detects this via `/api/health` and disables
those controls with a banner, so nothing is silently ignored.

Two more things worth knowing about serverless hosting:

- **Exports fall back to the browser.** Results are cached in instance memory
  for the download route, but consecutive requests can land on different
  instances. On a miss the route returns 404 and the UI builds the CSV/JSON
  locally from the result it already has.
- **Cloud IPs get blocked.** Plenty of sites refuse datacentre ranges, so a URL
  that scrapes fine from your machine may return 403 from Vercel. That shows up
  as a `blocked` error, not a crash.

### Anywhere that runs a normal Node process

Render, Railway, Fly.io, a container, a VPS — this is the full-featured mode:

```bash
npm ci && npx playwright install --with-deps chromium
PORT=3000 npm start
```

`playwright` is an **optional** dependency: the renderer imports it
dynamically and reports `renderer_unavailable` if it is missing, so
`npm install --omit=optional` gives a small static-only install that still
works.

## Tests

```bash
npm test        # 102 tests, no network access
```

Fixtures are local HTML files and a loopback HTTP server
(`tools/serve-fixture.mjs`), so the suite is deterministic and safe to run in
CI. It covers label interpretation, the resolver cascade, image harvesting and
dedupe, validators, link discovery, robots handling, error paths, CSV escaping,
and LLM grounding rejection.

To poke at the fixture site by hand:

```bash
node tools/serve-fixture.mjs      # http://localhost:8099
npm start                         # then scrape http://localhost:8099
```

---

## Project layout

```
src/
  cli.js  server.js  index.js
  core/      pipeline, fetcher, renderer, robots, page model, guards
  extract/   ontology, labels, structured data, images, patterns, resolvers, llm
  links/     internal-link discovery
  output/    result assembly, normalisation, exporters
  util/      url, text, logger
public/      the UI (no build step)
test/        tests + fixtures
tools/       fixture server
```

Vercel is configured with framework detection disabled because this project
serves `public/` statically and routes only `/api/*` to the Express serverless
function. This avoids treating the browser UI as an Express entrypoint.

## Adding a new field kind

The engine does not need changes to accept a new label — that is the point. Edit
the ontology only when you want a label matched *more sharply*:

1. Add an entry to `src/extract/ontology.js` with its `aliases` (what users
   type), `keywords` (what the page says), `schemaKeys` (JSON-LD property
   names), `attrHints` (class/id fragments) and `pageHints` (where it lives).
2. If it needs a new value kind, add a validator to `src/extract/patterns.js`
   and a case in `src/extract/resolvers.js`.
3. Add a fixture case to `test/fixtures/` and a test.

---

## Note on the earlier Python files

`fetcher.py`, `requirements.txt`, `urls.txt`, `demo_site/` and `output/` are
from an earlier prototype in this directory and are not used by this project.
Node was chosen because Python is not on this machine's PATH while Node 20 is,
and because Playwright is first-class in Node (see ARCHITECTURE.md §9). They are
left untouched — delete them when you no longer want them.
