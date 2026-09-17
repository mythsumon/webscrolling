/**
 * Image harvesting.
 *
 * Every candidate carries enough metadata (declared size, srcset width, DOM
 * position, alt text, surrounding text) for the resolvers to answer both
 * "which single image is the main one" and "which images are the gallery",
 * and to match a label like "Menu Image" against the right picture.
 */

import { absolutize, imageIdentity } from '../util/url.js';
import { squish } from '../util/text.js';

const LAZY_ATTRS = [
  'data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-lazyload',
  'data-echo', 'data-hi-res-src', 'data-large', 'data-large-file', 'data-full',
  'data-full-url', 'data-image', 'data-img', 'data-img-src', 'data-zoom-image',
  'data-zoom', 'data-bg', 'data-background', 'data-background-image',
  'data-thumb', 'data-flickity-lazyload', 'data-srcset', 'data-lazy-srcset',
];

/** URL substrings that mark an image as chrome rather than content. */
const JUNK_URL = /(sprite|favicon|\bicons?\b|icon-|-icon|pixel|1x1|spacer|blank\.|transparent\.|placeholder|loader|loading|spinner|avatar-default|tracking|analytics|beacon|\/ads?\/|badge|flag-|payment|visa|mastercard|paypal|social|share-|btn-|button-|arrow|chevron|close\.|menu\.|hamburger)/i;

/**
 * Classes/ids that mark the *container* as chrome.
 *
 * `logo` is deliberately absent: directory and e-commerce cards routinely wrap
 * the item's own photo in `.logo-box` / `.logo-wrap`, and dropping those left
 * every record in a listing with no image. A logo-ish context is instead
 * marked `isLogo` below, which keeps it out of page-level main/gallery images
 * while still letting a record fall back to it.
 */
const JUNK_CONTEXT = /(^|[\s_-])(icon|sprite|nav|navbar|menu-toggle|footer-logo|payment|social|share|advert|ads?|banner-ad|cookie|newsletter)([\s_-]|$)/i;

const GALLERY_CONTEXT = /(gallery|slider|carousel|slideshow|lightbox|photos?|images?|swiper|fotorama|thumbnails?|masonry|grid)/i;

const HERO_CONTEXT = /(hero|banner|masthead|jumbotron|cover|featured|main-image|primary-image|header-image)/i;

/**
 * Parse a srcset and return the highest-resolution entry.
 * @returns {{url: string, width: number|null, density: number|null}|null}
 */
export function bestFromSrcset(srcset) {
  if (!srcset || typeof srcset !== 'string') return null;
  const candidates = [];
  // A spec-compliant srcset separates candidates with ", ". Splitting on that
  // keeps commas *inside* URLs intact (Cloudinary's `w_400,h_300` segments,
  // data: URIs). Only if that yields nothing do we fall back to a bare comma
  // split, and then only when the string clearly holds several descriptors.
  let parts = srcset.split(/,(?=\s)/);
  if (parts.length === 1 && /\d+(?:\.\d+)?[wx]\s*,/.test(srcset)) {
    parts = srcset.split(',');
  }
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)([wx]))?\s*$/);
    if (!m) continue;
    const [, url, numStr, unit] = m;
    const num = numStr ? Number(numStr) : null;
    candidates.push({
      url,
      width: unit === 'w' ? num : null,
      density: unit === 'x' ? num : null,
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const aw = a.width ?? (a.density ?? 1) * 1000;
    const bw = b.width ?? (b.density ?? 1) * 1000;
    return bw - aw;
  });
  return candidates[0];
}

function parseDim(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cssUrls(styleValue) {
  if (!styleValue) return [];
  const out = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m;
  while ((m = re.exec(styleValue))) out.push(m[2].trim());
  return out;
}

/** Short selector for provenance, e.g. `div.gallery > img:nth-child(3)`. */
function describe($, el) {
  const $el = $(el);
  const tag = ($el.prop('tagName') || 'node').toLowerCase();
  const id = $el.attr('id');
  if (id) return `${tag}#${id}`;
  const cls = ($el.attr('class') || '').split(/\s+/).filter(Boolean).slice(0, 2);
  const parent = $el.parent();
  const pTag = (parent.prop('tagName') || '').toLowerCase();
  const pCls = (parent.attr('class') || '').split(/\s+/).filter(Boolean)[0];
  const self = cls.length ? `${tag}.${cls.join('.')}` : tag;
  return pTag ? `${pTag}${pCls ? `.${pCls}` : ''} > ${self}` : self;
}

/** Text near an image: alt, title, figcaption, container class names. */
function imageContext($, el) {
  const $el = $(el);
  const bits = [
    $el.attr('alt'),
    $el.attr('title'),
    $el.attr('aria-label'),
    $el.closest('figure').find('figcaption').first().text(),
    $el.attr('class'),
    $el.attr('id'),
    $el.parent().attr('class'),
    $el.parent().attr('id'),
    $el.closest('section, div[class], figure').first().attr('class'),
    $el.closest('section[id], div[id]').first().attr('id'),
  ];
  // Nearest preceding heading gives "Rooms", "Gallery", "Our Menu" etc.
  const heading = $el.closest('section, article, div').first().find('h1,h2,h3,h4').first().text();
  bits.push(heading);
  return squish(bits.filter(Boolean).join(' ')).toLowerCase();
}

/**
 * Harvest every image candidate on the page.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {object} ctx
 * @param {string} ctx.baseUrl        absolute base for relative URLs
 * @param {Record<string,string>} ctx.meta   output of parseMeta
 * @param {{entries: Array}} ctx.structuredIndex
 * @returns {Array<object>} candidates, in document order, deduped
 */
export function harvestImages($, { baseUrl, meta = {}, structuredIndex = { entries: [] } }) {
  /** @type {Array<object>} */
  const raw = [];
  let order = 0;

  const add = (url, info) => {
    const abs = absolutize(url, baseUrl);
    if (!abs) return;
    raw.push({
      url: abs,
      order: order++,
      width: info.width ?? null,
      height: info.height ?? null,
      alt: info.alt ?? '',
      context: info.context ?? '',
      selector: info.selector ?? null,
      channel: info.channel,
      trust: info.trust ?? 0.5,
      inGallery: info.inGallery ?? false,
      inHero: info.inHero ?? false,
      junkContext: info.junkContext ?? false,
    });
  };

  // --- Channel 1: Open Graph / Twitter / link rel -----------------------
  const metaImageKeys = [
    ['og:image:secure_url', 0.95],
    ['og:image:url', 0.95],
    ['og:image', 0.95],
    ['twitter:image', 0.9],
    ['twitter:image:src', 0.9],
    ['link:image_src', 0.85],
    ['thumbnailurl', 0.8],
    ['msapplication-tileimage', 0.3],
  ];
  const ogWidth = parseDim(meta['og:image:width']);
  const ogHeight = parseDim(meta['og:image:height']);
  for (const [key, trust] of metaImageKeys) {
    const val = meta[key];
    if (!val) continue;
    add(val, {
      channel: `meta:${key}`,
      trust,
      width: key.startsWith('og:image') ? ogWidth : null,
      height: key.startsWith('og:image') ? ogHeight : null,
      alt: meta['og:image:alt'] ?? '',
      context: 'og social preview primary main',
      inHero: key.startsWith('og:image'),
    });
  }

  // --- Channel 2: JSON-LD / microdata images ---------------------------
  for (const entry of structuredIndex.entries) {
    if (!['image', 'contenturl', 'thumbnailurl', 'photo', 'logo', 'primaryimageofpage'].includes(entry.key)) {
      continue;
    }
    if (!/^(https?:|\/|\.)/i.test(entry.value)) continue;
    add(entry.value, {
      channel: `${entry.source}:${entry.path}`,
      trust: entry.primary ? 0.95 : 0.8,
      context: `${entry.path} ${entry.key}`.toLowerCase(),
      inHero: entry.key === 'primaryimageofpage' || (entry.primary && entry.key === 'image'),
    });
  }

  // --- Channel 3: <img> (+ its srcset and lazy attributes) -------------
  // One candidate per element. An <img> with src + srcset + data-src is one
  // image at three resolutions, so emitting all three and deduping by URL
  // later would keep the thumbnail as a separate "gallery image".
  $('img').each((_, el) => {
    const $el = $(el);
    const context = imageContext($, el);
    const containerAttrs = squish(
      [
        $el.attr('class'), $el.attr('id'),
        $el.parent().attr('class'), $el.parent().attr('id'),
        $el.closest('[class]').first().attr('class'),
      ].filter(Boolean).join(' '),
    );
    const info = {
      alt: squish($el.attr('alt')),
      context,
      selector: describe($, el),
      width: parseDim($el.attr('width')),
      height: parseDim($el.attr('height')),
      inGallery: GALLERY_CONTEXT.test(context),
      inHero: HERO_CONTEXT.test(context),
      junkContext: JUNK_CONTEXT.test(containerAttrs),
    };

    /** @type {Array<{url: string, width: number|null, trust: number, channel: string}>} */
    const variants = [];

    // Explicit full-size lazy attributes, which beat the (often placeholder) src.
    for (const attr of LAZY_ATTRS) {
      const v = $el.attr(attr);
      if (!v) continue;
      if (attr.endsWith('srcset')) {
        const best = bestFromSrcset(v);
        if (best) variants.push({ url: best.url, width: best.width ?? info.width, trust: 0.8, channel: `img[${attr}]` });
      } else {
        for (const u of v.includes('url(') ? cssUrls(v) : [v]) {
          variants.push({ url: u, width: info.width, trust: 0.8, channel: `img[${attr}]` });
        }
      }
    }

    const srcset = $el.attr('srcset');
    if (srcset) {
      const best = bestFromSrcset(srcset);
      if (best) variants.push({ url: best.url, width: best.width ?? info.width, trust: 0.78, channel: 'img[srcset]' });
    }

    // <picture><source srcset> siblings describe the same image.
    $el.closest('picture').find('source[srcset], source[data-srcset]').each((__, sEl) => {
      const best = bestFromSrcset($(sEl).attr('srcset') || $(sEl).attr('data-srcset'));
      if (best) {
        variants.push({ url: best.url, width: best.width ?? info.width, trust: 0.75, channel: 'picture>source[srcset]' });
      }
    });

    const src = $el.attr('src');
    if (src) variants.push({ url: src, width: info.width, trust: 0.7, channel: 'img[src]' });

    const winner = pickBestVariant(variants);
    if (winner) add(winner.url, { ...info, ...winner });
  });

  // --- Channel 4: <source> outside <picture>, and <video poster> -------
  $('source[srcset]').each((_, el) => {
    if ($(el).closest('picture').find('img').length) return; // already handled
    const best = bestFromSrcset($(el).attr('srcset'));
    if (best) {
      add(best.url, {
        channel: 'source[srcset]',
        trust: 0.6,
        width: best.width,
        context: imageContext($, el),
        selector: describe($, el),
      });
    }
  });
  $('video[poster]').each((_, el) => {
    add($(el).attr('poster'), {
      channel: 'video[poster]',
      trust: 0.5,
      context: imageContext($, el),
      selector: describe($, el),
    });
  });

  // --- Channel 5: inline background-image ------------------------------
  $('[style*="background"]').each((_, el) => {
    const urls = cssUrls($(el).attr('style'));
    if (!urls.length) return;
    const context = imageContext($, el);
    for (const u of urls) {
      add(u, {
        channel: 'style:background-image',
        trust: 0.55,
        context,
        selector: describe($, el),
        inGallery: GALLERY_CONTEXT.test(context),
        inHero: HERO_CONTEXT.test(context),
        junkContext: JUNK_CONTEXT.test(squish($(el).attr('class') || '')),
      });
    }
  });

  // --- Channel 6: anchors that link straight to an image ---------------
  // Lightbox galleries put the full-size file on the <a>, the thumb on the <img>.
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(href)) return;
    const context = imageContext($, el);
    add(href, {
      channel: 'a[href=image]',
      trust: 0.72,
      context,
      selector: describe($, el),
      inGallery: GALLERY_CONTEXT.test(context) || !!$(el).attr('data-lightbox') || /lightbox|gallery/i.test($(el).attr('class') || ''),
    });
  });

  return dedupeImages(raw.filter((c) => !isJunkImage(c)));
}

/** Reject chrome, trackers and placeholders — before dedupe, so junk never wins. */
export function isJunkImage(candidate) {
  const { url, width, height, channel, context } = candidate;
  if (!url) return true;
  if (/^data:/i.test(url)) return true;
  if (/\.svg(\?|$)/i.test(url) && !/photo|gallery|hero/i.test(context || '')) return true;
  if (JUNK_URL.test(url)) return true;
  // Declared tiny images are spacers or icons, never content.
  if (width != null && width <= 100) return true;
  if (height != null && height <= 100) return true;
  if (candidate.junkContext && channel !== 'meta:og:image') return true;
  if (/(^|[\s_-])logo([\s_-]|$)/i.test(context || '') && !/gallery/i.test(context || '')) {
    // A logo is still a legitimate answer for the label "Logo", so keep it but
    // mark it: the resolver only picks it when the label asks for a logo.
    candidate.isLogo = true;
  }
  return false;
}

/**
 * Collapse CDN variants of the same image, keeping the highest-quality entry
 * and the union of its context signals.
 */
export function dedupeImages(candidates) {
  /** @type {Map<string, object>} */
  const byIdentity = new Map();
  for (const c of candidates) {
    const id = imageIdentity(c.url);
    const existing = byIdentity.get(id);
    if (!existing) {
      byIdentity.set(id, { ...c, identity: id });
      continue;
    }
    // Merge: keep the better URL, union the signals, keep the earliest position.
    const better = betterVariant(existing, c);
    byIdentity.set(id, {
      ...existing,
      url: better.url,
      width: Math.max(existing.width ?? 0, c.width ?? 0) || null,
      height: Math.max(existing.height ?? 0, c.height ?? 0) || null,
      trust: Math.max(existing.trust, c.trust),
      alt: existing.alt || c.alt,
      context: existing.context === c.context ? existing.context : `${existing.context} ${c.context}`.trim(),
      selector: existing.selector ?? c.selector,
      channel: existing.trust >= c.trust ? existing.channel : c.channel,
      order: Math.min(existing.order, c.order),
      inGallery: existing.inGallery || c.inGallery,
      inHero: existing.inHero || c.inHero,
      isLogo: existing.isLogo || c.isLogo,
    });
  }
  return [...byIdentity.values()].sort((a, b) => a.order - b.order);
}

/**
 * Quality score for one URL of an image. Higher is a bigger/better rendition.
 * Used both to pick between an element's own variants and to choose which of
 * two deduped CDN URLs to keep.
 */
function variantScore(c) {
  let s = 0;
  s += (c.width ?? 0) / 100;
  // Explicit size hints in the URL: bigger number wins.
  const m =
    c.url.match(/[?&](?:w|width)=(\d{2,5})/i) ||
    c.url.match(/[-_/](\d{3,5})x\d{3,5}[-_./]/) ||
    c.url.match(/[-_/](\d{3,5})\.(?:jpe?g|png|webp|avif)$/i);
  if (m) s += Number(m[1]) / 100;
  if (/(?:original|full|large|xl|2048|1920|1600)/i.test(c.url)) s += 8;
  if (/(?:thumb|thumbnail|small|-150x|-300x|_s\.|_t\.)/i.test(c.url)) s -= 10;
  // A base64 placeholder is never the real image.
  if (/^data:/i.test(c.url)) s -= 100;
  s += (c.trust ?? 0.5) * 2;
  return s;
}

/** Best rendition among one element's own variants. */
function pickBestVariant(variants) {
  const usable = variants.filter((v) => v.url && !/^data:/i.test(v.url.trim()));
  if (!usable.length) return null;
  return usable.reduce((best, v) => (variantScore(v) > variantScore(best) ? v : best));
}

/** Which of two URLs for the same image is the higher-quality one? */
function betterVariant(a, b) {
  return variantScore(b) > variantScore(a) ? b : a;
}

/**
 * Rank candidates for a single "main image" answer.
 * Order: og:image > structured primary > hero container > largest early image.
 */
export function rankForMain(candidates) {
  return [...candidates]
    .filter((c) => !c.isLogo)
    .map((c) => {
      let score = c.trust;
      if (c.channel.startsWith('meta:og:image')) score += 0.6;
      if (c.channel.includes('jsonld') || c.channel.includes('microdata')) score += 0.35;
      if (c.inHero) score += 0.25;
      if (c.inGallery) score -= 0.1; // a gallery thumb is rarely "the" main image
      if (c.order <= 3) score += 0.15;
      const area = (c.width ?? 0) * (c.height ?? 0);
      if (area > 300000) score += 0.15;
      return { ...c, mainScore: score };
    })
    .sort((a, b) => b.mainScore - a.mainScore || a.order - b.order);
}

/** Candidates that belong in a gallery list, in document order. */
export function rankForGallery(candidates, { exclude = [] } = {}) {
  const excluded = new Set(exclude.map((u) => imageIdentity(u)));
  const inGallery = candidates.filter((c) => c.inGallery && !excluded.has(c.identity));
  const pool = inGallery.length >= 2 ? inGallery : candidates.filter((c) => !excluded.has(c.identity));
  return pool
    .filter((c) => !c.isLogo && !c.channel.startsWith('meta:'))
    .sort((a, b) => a.order - b.order);
}
