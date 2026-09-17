/**
 * Access-restriction detection.
 *
 * We detect and report; we never circumvent. Every function here answers
 * "should we tell the caller this page is not legitimately readable?".
 */

const CAPTCHA_MARKERS = [
  'g-recaptcha',
  'grecaptcha',
  'recaptcha/api.js',
  'hcaptcha.com',
  'h-captcha',
  'cf-challenge',
  'cf_chl_opt',
  '__cf_chl',
  'challenges.cloudflare.com',
  'turnstile',
  'px-captcha',
  'perimeterx',
  'datadome',
  'incapsula',
  'distil_r_captcha',
];

const CAPTCHA_TEXT = [
  'just a moment',
  'checking your browser',
  'verify you are human',
  'are you a robot',
  'confirm you are not a robot',
  'enable javascript and cookies to continue',
  'unusual traffic',
  'access denied',
];

const PAYWALL_TEXT = [
  'subscribe to continue reading',
  'subscribers only',
  'this article is for subscribers',
  'become a member to read',
];

/**
 * @param {{status: number, html: string, text: string}} page
 * @returns {{type: string, message: string} | null}
 */
export function detectRestriction({ status, html, text }) {
  const lowerHtml = (html || '').toLowerCase();
  const lowerText = (text || '').toLowerCase();

  if (status === 401) {
    return { type: 'login_required', message: 'Server returned 401 Unauthorized — page requires authentication.' };
  }
  if (status === 402) {
    return { type: 'paywall', message: 'Server returned 402 Payment Required.' };
  }
  if (status === 403) {
    return { type: 'blocked', message: 'Server returned 403 Forbidden — request was blocked.' };
  }
  if (status === 429) {
    return { type: 'rate_limited', message: 'Server returned 429 Too Many Requests — back off and retry later.' };
  }

  for (const marker of CAPTCHA_MARKERS) {
    if (lowerHtml.includes(marker)) {
      return { type: 'captcha', message: `CAPTCHA / anti-bot challenge detected (${marker}). Not attempting to bypass.` };
    }
  }
  // Short pages that say "just a moment" are challenges; long articles that
  // merely mention the phrase are not.
  if (lowerText.length < 1200) {
    for (const phrase of CAPTCHA_TEXT) {
      if (lowerText.includes(phrase)) {
        return { type: 'captcha', message: `Anti-bot interstitial detected ("${phrase}"). Not attempting to bypass.` };
      }
    }
  }
  for (const phrase of PAYWALL_TEXT) {
    if (lowerText.includes(phrase)) {
      return { type: 'paywall', message: `Paywall detected ("${phrase}"). Not attempting to bypass.` };
    }
  }
  return null;
}

/**
 * A login wall is a password field on a page with little other content.
 * A normal site with a member-login form in the header is not a login wall.
 */
export function detectLoginWall($, text) {
  const passwordFields = $('input[type="password"]').length;
  if (!passwordFields) return null;
  if ((text || '').length > 2500) return null;
  return {
    type: 'login_required',
    message: 'Page appears to be a login form with no public content. Not attempting to authenticate.',
  };
}
