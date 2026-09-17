/**
 * URL validation, absolutisation and normalisation.
 *
 * Normalisation exists for one reason: deduplication. Two URLs that fetch the
 * same bytes must produce the same key, or we visit pages twice and return the
 * same image three times.
 */

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|mc_cid$|mc_eid$|ref$|referrer$|_ga$|yclid$|igshid$)/i;

/** Image CDN sizing params — stripped when comparing image identity. */
const IMAGE_SIZE_PARAMS = new Set([
  'w', 'h', 'width', 'height', 'q', 'quality', 'fit', 'crop', 'dpr',
  'format', 'fm', 'auto', 'resize', 'size', 's', 'tr', 'c',
]);

const NON_HTML_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tiff',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv',
  'zip', 'rar', '7z', 'tar', 'gz',
  'mp3', 'mp4', 'webm', 'avi', 'mov', 'wmv', 'ogg', 'wav', 'm4a',
  'css', 'js', 'json', 'xml', 'rss', 'atom', 'woff', 'woff2', 'ttf', 'eot',
  'exe', 'dmg', 'apk',
]);

/**
 * Validate and canonicalise user input. Accepts bare hosts ("example.com").
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
export function validateUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, reason: 'URL is empty.' };
  }
  let raw = input.trim();

  // Users paste bare hosts constantly; assume a scheme rather than rejecting.
  // The colon test must not treat "localhost:8099" as the scheme "localhost",
  // so a scheme only counts when followed by "//" or by a non-digit.
  const hasScheme =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(raw);
  if (!hasScheme) {
    // Local dev servers are http; anything public gets https.
    const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(raw);
    raw = `${local ? 'http' : 'https'}://${raw}`;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `Not a parseable URL: ${input}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported protocol "${parsed.protocol}" (only http/https).` };
  }
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    // Reject "https://localhost" only for hostnames that cannot be public;
    // localhost itself is allowed because fixtures and dev servers use it.
    if (parsed.hostname !== 'localhost') {
      return { ok: false, reason: `Hostname "${parsed.hostname}" does not look like a domain.` };
    }
  }

  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}

/** Resolve `href` against `base`; returns null for unusable hrefs. */
export function absolutize(href, base) {
  if (!href || typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^(javascript|mailto|tel|sms|data|about|blob|#)/i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Canonical form for page-visit deduplication: lowercase host, no hash, no
 * tracking params, sorted query, no trailing slash on paths.
 */
export function normalizeUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return String(url);
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

/**
 * Identity key for an image: like normalizeUrl but also strips CDN size/quality
 * params, so photo.jpg?w=400 and photo.jpg?w=1600 collapse to one image.
 */
export function imageIdentity(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return String(url);
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !IMAGE_SIZE_PARAMS.has(k.toLowerCase()) && !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // Collapse common path-based resize segments: /w_800/, /800x600/, /-300x200.jpg
  let path = u.pathname
    .replace(/\/(?:w|h|c|q)_\d+(?:,[a-z]+_[\w.]+)*\//gi, '/')
    .replace(/\/\d{2,4}x\d{2,4}\//g, '/')
    .replace(/[-_]\d{2,4}x\d{2,4}(\.[a-z0-9]+)$/i, '$1')
    .replace(/[-_](?:thumb|thumbnail|small|medium|large|scaled)(\.[a-z0-9]+)$/i, '$1');
  u.pathname = path;
  return u.toString();
}

/** Same registrable-ish domain check (last two labels; good enough, no PSL dep). */
export function sameSite(a, b) {
  try {
    const ha = new URL(a).hostname.toLowerCase().replace(/^www\./, '');
    const hb = new URL(b).hostname.toLowerCase().replace(/^www\./, '');
    if (ha === hb) return true;
    const ra = ha.split('.').slice(-2).join('.');
    const rb = hb.split('.').slice(-2).join('.');
    return ra === rb;
  } catch {
    return false;
  }
}

/** Does this URL point at something that is clearly not an HTML page? */
export function looksNonHtml(url) {
  try {
    const { pathname } = new URL(url);
    const m = pathname.match(/\.([a-z0-9]{1,5})$/i);
    return !!m && NON_HTML_EXT.has(m[1].toLowerCase());
  } catch {
    return false;
  }
}

/** Page extensions that are part of the plumbing, not part of the meaning. */
const PAGE_EXT_RE = /\.(html?|php|aspx?|jsp|jspx|shtml|cfm|do)$/i;

/**
 * Path + query tokens, for relevance scoring of internal links.
 *
 * The page extension is stripped first: without that, the last token of
 * `/contact.html` is "html", and every extension-bearing URL loses its
 * slug — which silently disabled the whole page-prior table on static sites.
 */
export function urlTokens(url) {
  try {
    const u = new URL(url);
    return `${u.pathname.replace(PAGE_EXT_RE, '')} ${u.search}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);
  } catch {
    return [];
  }
}

export function origin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
