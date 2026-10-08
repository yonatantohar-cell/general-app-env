/* The single file, opened the way she would open it: straight from disk, with
 * no network at all and no account. Every request other than the document
 * itself is blocked, so anything the file still needs to fetch fails loudly
 * here rather than quietly on her phone.
 *
 * node standalone.test.js
 */
const { chromium } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SRC = path.join(__dirname, 'amirnet-standalone.html');
const FILE = 'file://' + SRC;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  let fail = 0;
  const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };

  const bytes = fs.readFileSync(SRC);
  console.log('file: ' + (bytes.length / 1024 / 1024).toFixed(2) + 'MB');
  check(bytes.length < 16 * 1024 * 1024, 'the file is small enough to send');

  /* ----------------------------------------------------------------
   * ENCODING. exam.html carries no charset of its own — the publisher's
   * skeleton supplies it — so a file built from it and opened by something
   * that does not sniff UTF-8 renders every Hebrew letter as mojibake. That
   * is what an iOS file preview did. These are the bytes that prevent it.
   * ---------------------------------------------------------------- */
  console.log('\n=== how the file declares its encoding ===');
  check(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    'it starts with a UTF-8 BOM, which outranks any viewer default');
  const head1k = bytes.slice(0, 1024).toString('utf8');
  check(/^\uFEFF<!doctype html>/i.test(head1k), 'a doctype follows immediately');
  check(/<meta\s+charset=["']?utf-8/i.test(head1k), 'and a charset meta inside the first 1024 bytes');
  check(/<html[^>]+lang="he"[^>]+dir="rtl"/i.test(head1k), 'the document is declared Hebrew and right-to-left');

  for (const [label, width, height] of [['phone', 390, 844], ['desktop', 1280, 900]]) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    const errors = [];
    const blocked = [];
    page.on('pageerror', (e) => errors.push(e.message));
    /* Nothing but the document may load — not even a font. */
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('file://')) return route.continue();
      blocked.push(u);
      return route.abort();
    });
    await page.addInitScript(() => { try { delete window.claude } catch (e) { window.claude = undefined } });

    await page.goto(FILE);
    await page.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
    console.log('\n=== ' + label + ' ' + width + 'x' + height + ' (offline, from disk) ===');
    console.log('  blocked ' + blocked.length + ' network requests');

    const sims = await page.$$eval('.sim', (s) => s.length);
    check(sims === 20, 'all 20 simulations loaded from inside the file (' + sims + ')');
    check(await page.evaluate(() => typeof Hints !== 'undefined'), 'the hint engine is inlined');

    /* A real simulation: first section, answered and scored. */
    await page.click('.sim');
    await page.waitForSelector('.sect-intro .btn');
    await page.click('.sect-intro .btn');
    await page.waitForSelector('.qbox');
    const opts = await page.$$('.qbox .opt');
    check(opts.length >= 4, 'a question renders with its options (' + opts.length + ')');
    const dots = await page.$$('.dot');
    for (let i = 0; i < dots.length; i++) {
      const d = await page.$$('.dot');
      await d[i].click();
      const o = await page.$$('.qbox .opt');
      await o[0].click();
    }
    const d2 = await page.$$('.dot');
    await d2[d2.length - 1].click();
    await page.click('.nav > .btn');
    await page.waitForSelector('.sect-intro, .score', { timeout: 10000 });
    check(true, 'a section can be completed end to end');

    /* The course bank and the word pool, both inlined. */
    await page.click('#quit');
    const armed = await page.evaluate(() => document.getElementById('quit').textContent.indexOf('שוב') >= 0);
    if (armed) await page.click('#quit');
    await page.waitForSelector('#tab-vocab');
    await page.click('#tab-vocab');
    await page.waitForSelector('#vocabSearch');
    await page.waitForFunction(() => document.querySelectorAll('#vocabList .card').length > 0, { timeout: 15000 });
    const vocabRows = await page.$$eval('#vocabList .card', (c) => c.length);
    check(vocabRows > 100, 'the vocabulary list loaded (' + vocabRows + ' rows)');
    await page.waitForFunction(() => document.querySelectorAll('#vocabList .expl').length > 0, { timeout: 15000 });
    const word = await page.evaluate(() => {
      const card = document.querySelector('#vocabList .expl').closest('.card');
      card.querySelector('.expl .btn').click();
      return card.querySelector('.en').textContent.trim();
    });
    await page.waitForTimeout(300);
    check(!!word, 'a course hook can be saved offline (' + word + ')');

    await page.click('#tab-trainer');
    await page.waitForSelector('#pane-trainer .pick', { timeout: 15000 });
    const modes = await (await page.$$('#pane-trainer .pick'))[0]
      .$$eval('button', (b) => b.map((x) => x.textContent.trim()));
    check(modes.length === 3, 'the trainer works offline (' + JSON.stringify(modes) + ')');
    const pane = await page.textContent('#pane-trainer');
    check(/בדפדפן הזה בלבד/.test(pane), 'it says where the progress is kept');

    /* The whole training loop, offline, from inside the one file. */
    check(await page.evaluate(() => typeof Judge !== 'undefined'), 'the offline judge is inlined');
    await page.waitForSelector('#guessField', { timeout: 15000 });
    const w = (await page.textContent('#pane-trainer .card .en')).trim();
    const he = await page.evaluate((x) => {
      const e = (window.__BUNDLE['trainer-words.json'] || []).filter((t) => t.word === x)[0];
      return e ? e.he : '';
    }, w);
    check(!!he, 'the served word has a stored meaning (' + w + ' = ' + he + ')');
    await page.fill('#guessField', he.split(',')[0].trim());
    await page.click('#pane-trainer .card .row .btn');
    await page.waitForSelector('#pane-trainer .verdict', { timeout: 10000 });
    const verdict = (await page.textContent('#pane-trainer .verdict')).trim();
    check(verdict === 'נכון', 'a guess is judged offline, inside the file (' + verdict + ')');

    check(errors.length === 0, 'no errors' + (errors[0] ? ': ' + errors[0] : ''));
    await page.screenshot({ path: '/tmp/standalone-' + label + '.png' });
    await ctx.close();
  }

  /* ------------------------------------------------------------------
   * The hostile case: served while being TOLD it is Latin-1. By the HTML
   * spec a BOM outranks both the HTTP header and the meta tag, so if the
   * Hebrew survives this, it survives anything that merely guesses wrong.
   * ------------------------------------------------------------------ */
  console.log('\n=== served with a deliberately wrong charset ===');
  {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=ISO-8859-1' });
      res.end(bytes);
    });
    await new Promise((r) => server.listen(8799, '127.0.0.1', r));
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(() => { try { delete window.claude } catch (e) { window.claude = undefined } });
    await page.goto('http://127.0.0.1:8799/');
    await page.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
    const seen = await page.evaluate(() => ({
      title: document.title,
      h1: (document.querySelector('h1') || {}).textContent || '',
      enc: document.characterSet,
    }));
    console.log('  charset in use: ' + seen.enc + ' · h1: ' + seen.h1);
    check(seen.h1 === 'חדר מבחן אמירנט', 'the Hebrew heading is intact (' + seen.h1 + ')');
    check(seen.title === 'חדר מבחן אמירנט', 'so is the title (' + seen.title + ')');
    check(!/[ÃÂ×Ÿ]/.test(seen.h1 + seen.title), 'no mojibake characters anywhere in them');
    check(/UTF-8/i.test(seen.enc), 'the browser settled on UTF-8 despite being told otherwise');
    await page.close();
    await new Promise((r) => server.close(r));
  }

  await browser.close();
  console.log(fail === 0 ? '\nThe standalone file works offline.\n' : '\n' + fail + ' FAILED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
