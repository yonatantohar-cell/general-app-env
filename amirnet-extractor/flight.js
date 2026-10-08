'use strict';

/**
 * flight.js — pulls structured data out of a Next.js App Router page.
 *
 * Why this exists: amirnetwords.com renders its simulations client-side. The
 * served HTML says "טוען מבחן…" (loading) and contains no questions at all, so
 * every HTML-scraping approach returns nothing. The real data ships inside the
 * React Flight payload — a series of
 *
 *     self.__next_f.push([1, "<escaped JSON fragment>"])
 *
 * calls whose string arguments concatenate into one long document. Reading it
 * directly is both easier and far more reliable than driving a headless
 * browser, and it yields the complete record (answers, explanations) rather
 * than whatever happens to be on screen.
 */

const cheerio = require('cheerio');

/** Concatenate every `self.__next_f.push([n, "..."])` chunk into one string. */
function extractFlightPayload(html) {
  const $ = cheerio.load(html);
  let payload = '';

  $('script').each((_, element) => {
    const body = $(element).html() || '';
    if (!body.includes('__next_f')) return;

    // The second argument is a JS string literal; let JSON.parse do the
    // unescaping rather than hand-rolling backslash handling.
    const pattern = /self\.__next_f\.push\(\[\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
    let match;
    while ((match = pattern.exec(body)) !== null) {
      try {
        payload += JSON.parse(match[1]);
      } catch {
        // A chunk that will not parse is skipped; the rest still concatenates.
      }
    }
  });

  return payload;
}

/**
 * Pull one balanced JSON object out of a larger text, given its key.
 *
 * The payload is not valid JSON as a whole (it is a Flight stream), so we
 * cannot parse it wholesale. Scanning for balanced braces while respecting
 * string literals and escapes is what makes this safe — a naive brace count
 * breaks on any `{` inside a question's text.
 *
 * @param {string} text
 * @param {string} key e.g. '"test":'
 * @returns {object|null}
 */
function extractObjectAfterKey(text, key) {
  const keyAt = text.indexOf(key);
  if (keyAt === -1) return null;

  const start = text.indexOf('{', keyAt + key.length - 1);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

module.exports = { extractFlightPayload, extractObjectAfterKey };
