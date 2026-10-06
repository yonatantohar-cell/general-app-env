'use strict';

/**
 * fetch.js — HTTP layer with correct Hebrew decoding.
 *
 * The important part here is NOT the HTTP. It is the decoding.
 *
 * Israeli sites are often served as windows-1255 (or ISO-8859-8). If you let
 * axios hand you a string, it decodes as UTF-8 and every Hebrew character
 * becomes a replacement char or Latin-1 garbage — and nothing throws, so the
 * failure shows up as "×ž×¡×¢×“×ª" in the final CSV/JSON rather than as an error.
 *
 * So: always request raw bytes, decide the charset explicitly, then decode.
 */

const fs = require('fs');
const path = require('path');

const axios = require('axios');
const iconv = require('iconv-lite');

const CACHE_DIR = path.join(__dirname, 'cache');

const DEFAULTS = {
  timeoutMs: 20000,
  maxRetries: 4,
  baseDelayMs: 1000,
  politeDelayMs: 800, // between successive page requests
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const client = axios.create({
  timeout: DEFAULTS.timeoutMs,
  responseType: 'arraybuffer', // raw bytes — we decode ourselves
  maxRedirects: 5,
  headers: {
    'User-Agent': DEFAULTS.userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  },
  validateStatus: () => true,
});

// ---------------------------------------------------------------------------
// Charset detection
// ---------------------------------------------------------------------------

/** Pull `charset=` out of a Content-Type header value. */
function charsetFromHeader(contentType) {
  if (!contentType) return null;
  const match = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Pull the charset out of the document's own <meta> tags.
 * Read from a Latin-1 view of the bytes: meta tags are ASCII, so this is safe
 * regardless of the real encoding, and avoids a chicken-and-egg problem.
 */
function charsetFromMeta(buffer) {
  const head = iconv.decode(buffer.subarray(0, 4096), 'latin1');
  const m1 = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  if (m1) return m1[1].toLowerCase();
  const m2 = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head);
  return m2 ? m2[1].toLowerCase() : null;
}

/** Count U+FFFD — the marker of a failed decode. */
function replacementCharCount(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0xfffd) count += 1;
  return count;
}

const HEBREW = /[֐-׿]/;

/**
 * Decode bytes to a string, declared charset first, with a sanity check.
 *
 * A site can *declare* UTF-8 and still serve windows-1255 (or the other way
 * round). So after decoding we check the result: if it is littered with
 * replacement characters and the alternative decoding produces actual Hebrew
 * letters, trust the bytes over the declaration.
 *
 * @returns {{text: string, charset: string, declared: string|null, overridden: boolean}}
 */
function decodeBuffer(buffer, declaredCharset) {
  const declared = declaredCharset ? declaredCharset.toLowerCase() : null;
  const primary = declared && iconv.encodingExists(declared) ? declared : 'utf-8';

  let text = iconv.decode(buffer, primary);
  const bad = replacementCharCount(text);

  // More than a handful of replacement chars means the decode is wrong.
  if (bad > 3) {
    for (const candidate of ['windows-1255', 'iso-8859-8', 'utf-8']) {
      if (candidate === primary) continue;
      const alternative = iconv.decode(buffer, candidate);
      if (replacementCharCount(alternative) < bad && HEBREW.test(alternative)) {
        return { text: alternative, charset: candidate, declared, overridden: true };
      }
    }
  }

  return { text, charset: primary, declared, overridden: false };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function isRetryableNetworkError(err) {
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'EPIPE'].includes(err.code);
}

function retryAfterMs(headers) {
  const header = headers && (headers['retry-after'] || headers['Retry-After']);
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * GET a URL and return decoded HTML.
 * @returns {Promise<{url:string, status:number, html:string, charset:string, overridden:boolean, bytes:number}>}
 */
async function fetchPage(url, { attempt = 0, log = console } = {}) {
  let response;
  try {
    response = await client.get(url);
  } catch (err) {
    if (isRetryableNetworkError(err) && attempt < DEFAULTS.maxRetries) {
      const delay = DEFAULTS.baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
      log.warn?.(`  network ${err.code} on ${url} — retry in ${delay}ms`);
      await sleep(delay);
      return fetchPage(url, { attempt: attempt + 1, log });
    }
    const wrapped = new Error(`Network failure fetching ${url}: ${err.message}`);
    wrapped.code = err.code;
    throw wrapped;
  }

  const { status, headers } = response;
  const buffer = Buffer.from(response.data);

  if (isRetryableStatus(status) && attempt < DEFAULTS.maxRetries) {
    const suggested = retryAfterMs(headers);
    const backoff = DEFAULTS.baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
    const delay = suggested !== null ? Math.max(suggested, backoff) : backoff;
    log.warn?.(`  HTTP ${status} on ${url} — retry in ${delay}ms`);
    await sleep(delay);
    return fetchPage(url, { attempt: attempt + 1, log });
  }

  if (status >= 400) {
    const error = new Error(`HTTP ${status} fetching ${url}`);
    error.status = status;
    throw error;
  }

  const declared = charsetFromHeader(headers['content-type']) || charsetFromMeta(buffer);
  const decoded = decodeBuffer(buffer, declared);

  return {
    url,
    status,
    html: decoded.text,
    charset: decoded.charset,
    declaredCharset: decoded.declared,
    overridden: decoded.overridden,
    bytes: buffer.length,
  };
}

// ---------------------------------------------------------------------------
// Raw-HTML cache
// ---------------------------------------------------------------------------

function cacheKey(url) {
  return (
    url
      .replace(/^https?:\/\//, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 150) + '.html'
  );
}

/**
 * Fetch, but reuse a cached copy when present.
 *
 * Calibrating a parser means running it many times against the same pages.
 * Re-downloading each time would be slow and rude; the cache makes parser
 * iteration free and keeps the site to a single request per page.
 */
async function fetchPageCached(url, { refresh = false, log = console } = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, cacheKey(url));

  if (!refresh && fs.existsSync(file)) {
    return {
      url,
      status: 200,
      html: fs.readFileSync(file, 'utf8'),
      charset: 'utf-8 (from cache)',
      fromCache: true,
      bytes: fs.statSync(file).size,
    };
  }

  const result = await fetchPage(url, { log });
  // Always cache as UTF-8 so re-reads need no charset logic.
  fs.writeFileSync(file, result.html, 'utf8');
  return { ...result, fromCache: false };
}

/** Read already-saved pages from a directory (the "I saved them myself" path). */
function readLocalPages(dir) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(html?|xhtml)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  return entries.map((entry) => {
    const file = path.join(dir, entry.name);
    const buffer = fs.readFileSync(file);
    const decoded = decodeBuffer(buffer, charsetFromMeta(buffer));
    return {
      url: `file://${file}`,
      sourceName: entry.name,
      status: 200,
      html: decoded.text,
      charset: decoded.charset,
      overridden: decoded.overridden,
      bytes: buffer.length,
    };
  });
}

module.exports = {
  fetchPage,
  fetchPageCached,
  readLocalPages,
  decodeBuffer,
  charsetFromHeader,
  charsetFromMeta,
  sleep,
  CACHE_DIR,
  DEFAULTS,
};
