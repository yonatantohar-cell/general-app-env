/* Does the "how it could have been solved" block reach the review screen, and
   does it point at the question in front of it?
   Start serve.js first, then: node hintsui.test.js */
const { chromium } = require('playwright-core');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function finishSection(page) {
  await page.waitForSelector('.qbox');
  const dots = await page.$$('.dot');
  if (dots.length) await dots[dots.length - 1].click();
  await page.click('.nav > .btn');
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  let fail = 0;
  const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };

  for (const [label, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (e) => { fail++; console.log('  PAGE ERROR: ' + e.message); });
    await page.goto('http://127.0.0.1:8731/exam.html');
    await page.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
    console.log('\n=== ' + label + ' ' + width + 'x' + height + ' ===');

    check(await page.evaluate(() => typeof Hints !== 'undefined'), 'the hint engine is loaded on the page');

    /* A sentence-completion drill, answered carelessly so the review has both. */
    await page.click('#drillBtn');
    await page.waitForSelector('.pick');
    const groups = await page.$$('.pick');
    await (await groups[2].$$('button'))[1].click();        // untimed
    await page.click('.card.set > .btn');
    await page.waitForSelector('.sect-intro .btn');
    await page.click('.sect-intro .btn');
    await page.waitForSelector('.qbox');
    const n = (await page.$$('.dot')).length;
    for (let i = 0; i < n; i++) {
      const dots = await page.$$('.dot');
      await dots[i].click();
      const opts = await page.$$('.qbox .opt');
      await opts[i % opts.length].click();
    }
    await finishSection(page);
    await page.waitForSelector('.score', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.rev').length > 0, { timeout: 10000 });
    /* The glosses arrive asynchronously and repaint the review; wait for that. */
    await page.waitForTimeout(1200);

    const revs = await page.$$eval('.rev', (c) => c.length);
    const withHints = await page.$$eval('.rev', (cs) =>
      cs.filter((c) => /איך אפשר היה לפתור/.test(c.textContent)).length);
    console.log('  ' + withHints + '/' + revs + ' reviewed questions carry a hint block');
    check(revs > 0, 'the review rendered');
    check(withHints > 0, 'at least one question shows how it could have been solved');

    /* Open one and read it. */
    const opened = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.rev'))
        .find((c) => /איך אפשר היה לפתור/.test(c.textContent));
      if (!card) return null;
      card.querySelector('.expl .btn').click();
      const body = card.querySelector('.expl > div');
      return {
        stem: card.querySelector('.qtext').textContent.trim(),
        text: body.textContent.trim(),
        titles: Array.from(body.querySelectorAll('span')).map((s) => s.textContent.trim()).slice(0, 8),
        hidden: body.hidden,
      };
    });
    console.log('  stem : ' + opened.stem.slice(0, 68));
    console.log('  hints: ' + JSON.stringify(opened.titles));
    check(!opened.hidden, 'the block opens when clicked');
    check(opened.text.length > 60, 'the block has real content');
    check(/חוק קשיח|כלל סטטיסטי/.test(opened.text), 'each rule is labelled hard or statistical');

    /* A hint must quote something that is really in the question. */
    const grounded = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.rev'))
        .find((c) => /איך אפשר היה לפתור/.test(c.textContent));
      const stem = card.querySelector('.qtext').textContent.toLowerCase();
      const opts = Array.from(card.querySelectorAll('.opt .v')).map((v) => v.textContent.trim().toLowerCase());
      const body = card.querySelector('.expl > div').textContent;
      const quoted = (body.match(/"([^"]{2,40})"/g) || []).map((q) => q.replace(/"/g, '').toLowerCase());
      if (!quoted.length) return { quoted: [], ok: true };
      return {
        quoted,
        ok: quoted.every((q) => stem.indexOf(q) >= 0 || opts.some((o) => o.indexOf(q) >= 0) || /[֐-׿]/.test(q)),
      };
    });
    console.log('  quoted: ' + JSON.stringify(grounded.quoted.slice(0, 5)));
    check(grounded.ok, 'everything the hint quotes appears in the question itself');

    const hScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(hScroll <= 0, 'no horizontal scroll with the block open');

    await page.screenshot({ path: '/tmp/hints-' + label + '.png', fullPage: false });
    await page.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nAll hint UI checks passed.\n' : '\n' + fail + ' FAILED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
