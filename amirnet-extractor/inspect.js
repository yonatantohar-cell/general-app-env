'use strict';

/**
 * inspect.js — structural reconnaissance on a page.
 *
 *   node inspect.js https://amirnetwords.com/tests
 *   node inspect.js ./saved-pages/test1.html
 *
 * This answers the one question that decides the whole extraction strategy:
 * WHERE does the content actually live? Server HTML, an inline JSON blob, or
 * an API the page calls after load? Guessing wrong here means writing a parser
 * twice, so this runs first.
 */

const fs = require('fs');

const cheerio = require('cheerio');

const { fetchPageCached, decodeBuffer, charsetFromMeta } = require('./fetch.js');

function loadInline(target) {
  const buffer = fs.readFileSync(target);
  const decoded = decodeBuffer(buffer, charsetFromMeta(buffer));
  return { url: `file://${target}`, html: decoded.text, charset: decoded.charset, bytes: buffer.length };
}

/** Inline JSON blobs that frameworks leave in the HTML. */
function findInlineData($, html) {
  const found = [];

  const wellKnown = ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__APOLLO_STATE__', '__DATA__'];
  for (const name of wellKnown) {
    if (html.includes(name)) found.push(name);
  }

  $('script').each((_, element) => {
    const type = $(element).attr('type') || '';
    const id = $(element).attr('id') || '';
    const body = $(element).html() || '';
    if (/json/i.test(type)) found.push(`script[type="${type}"]${id ? `#${id}` : ''} (${body.length}b)`);
    // A big script that assigns an array/object of question-ish data.
    if (body.length > 200 && /question|answer|options|תשוב|שאל/i.test(body)) {
      found.push(`inline script mentioning question/answer (${body.length}b)`);
    }
  });

  return [...new Set(found)];
}

/** Classes/ids whose names suggest quiz structure. */
function findSuspiciousSelectors($) {
  const hits = new Map();
  const pattern = /quiz|question|answer|option|test|sim|choice|exam|שאל|תשוב/i;

  $('[class], [id]').each((_, element) => {
    const attributes = [$(element).attr('class') || '', $(element).attr('id') || ''].join(' ');
    for (const token of attributes.split(/\s+/).filter(Boolean)) {
      if (pattern.test(token)) hits.set(token, (hits.get(token) || 0) + 1);
    }
  });

  return [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node inspect.js <url|file>');
    process.exit(1);
  }

  const load = /^https?:\/\//.test(target)
    ? fetchPageCached(target, { refresh: process.argv.includes('--refresh') })
    : Promise.resolve(loadInline(target));

  load
    .then((page) => {
      const $ = cheerio.load(page.html);
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
      const scripts = $('script').length;
      const scriptBytes = $('script').toArray().reduce((sum, el) => sum + ($(el).html() || '').length, 0);

      console.log('\n=== PAGE ===');
      console.log(`  url        : ${page.url}`);
      console.log(`  bytes      : ${page.bytes}`);
      console.log(`  charset    : ${page.charset}${page.overridden ? '  (OVERRIDDEN — site mis-declared it)' : ''}`);
      console.log(`  title      : ${$('title').first().text().trim()}`);
      console.log(`  from cache : ${page.fromCache ? 'yes' : 'no'}`);

      console.log('\n=== SHAPE ===');
      console.log(`  body text length : ${bodyText.length}`);
      console.log(`  <script> tags    : ${scripts} (${scriptBytes} bytes inline)`);
      console.log(`  forms / inputs   : ${$('form').length} / ${$('input').length}`);
      console.log(`  radio inputs     : ${$('input[type=radio]').length}   <-- strong quiz signal`);
      console.log(`  <li> / <label>   : ${$('li').length} / ${$('label').length}`);
      console.log(`  <table> / <iframe>: ${$('table').length} / ${$('iframe').length}`);

      // An SPA shell has lots of JS and almost no text.
      const looksLikeSpa = bodyText.length < 600 && scriptBytes > 2000;
      console.log(`\n  verdict: ${looksLikeSpa ? 'LIKELY a JS-rendered SPA shell -> needs Playwright or the underlying API' : 'content appears present in server HTML -> cheerio should work'}`);

      const inline = findInlineData($, page.html);
      console.log('\n=== INLINE DATA ===');
      if (inline.length === 0) console.log('  (none found)');
      else inline.forEach((item) => console.log(`  - ${item}`));

      console.log('\n=== QUIZ-ISH CLASSES/IDS (name -> count) ===');
      const selectors = findSuspiciousSelectors($);
      if (selectors.length === 0) console.log('  (none found)');
      else selectors.forEach(([name, count]) => console.log(`  ${String(count).padStart(4)}  ${name}`));

      console.log('\n=== LINKS THAT LOOK LIKE SIMULATIONS ===');
      const links = new Map();
      $('a[href]').each((_, element) => {
        const href = $(element).attr('href');
        const text = $(element).text().replace(/\s+/g, ' ').trim();
        if (/test|sim|quiz|exam|\d+/i.test(`${href} ${text}`)) links.set(href, text.slice(0, 60));
      });
      [...links.entries()].slice(0, 40).forEach(([href, text]) => console.log(`  ${href}  ::  ${text}`));
      console.log(`  (${links.size} candidate link(s) total)`);

      console.log('\n=== FIRST 1200 CHARS OF VISIBLE TEXT ===');
      console.log(bodyText.slice(0, 1200));
      console.log('');
    })
    .catch((err) => {
      console.error(`\ninspect failed: ${err.message}\n`);
      process.exit(1);
    });
}

if (require.main === module) main();
