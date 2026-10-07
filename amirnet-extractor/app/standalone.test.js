/* The single file, opened the way she would open it: straight from disk, with
 * no network at all and no account. Every request other than the document
 * itself is blocked, so anything the file still needs to fetch fails loudly
 * here rather than quietly on her phone.
 *
 * node standalone.test.js
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FILE = 'file://' + path.join(__dirname, 'amirnet-standalone.html');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  let fail = 0;
  const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };

  const size = fs.statSync(path.join(__dirname, 'amirnet-standalone.html')).size;
  console.log('file: ' + (size / 1024 / 1024).toFixed(2) + 'MB');
  check(size < 16 * 1024 * 1024, 'the file is small enough to send');

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

    check(errors.length === 0, 'no errors' + (errors[0] ? ': ' + errors[0] : ''));
    await page.screenshot({ path: '/tmp/standalone-' + label + '.png' });
    await ctx.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nThe standalone file works offline.\n' : '\n' + fail + ' FAILED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
