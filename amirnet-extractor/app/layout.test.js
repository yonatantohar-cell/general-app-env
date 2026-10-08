/* Browser check for the reading-section split layout.
   Start serve.js first, then: node layout.test.js */
const { chromium } = require('playwright-core');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* The last question's "next" button becomes "finish section", so jump to the
   last question via the dots before clicking it. */
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

    await page.click('.sim');
    for (let i = 0; i < 6; i++) {
      await page.waitForSelector('.sect-intro .btn', { timeout: 10000 });
      const title = (await page.textContent('.sect-intro h2')) || '';
      await page.click('.sect-intro .btn');
      if (title.indexOf('הנקרא') >= 0) break;
      await finishSection(page);
    }
    await page.waitForSelector('.rc-split', { timeout: 10000 });

    const m = await page.evaluate(() => {
      const p = document.querySelector('.rc-passage');
      const q = document.querySelector('.rc-questions');
      const pr = p.getBoundingClientRect(), qr = q.getBoundingClientRect();
      return {
        side: Math.abs(pr.top - qr.top) < 40 && Math.abs(pr.left - qr.left) > 50,
        stacked: qr.top > pr.top + 40,
        hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        pOverflowY: getComputedStyle(p).overflowY,
        pBounded: getComputedStyle(p).maxHeight !== 'none',
        pScrolls: p.scrollHeight > p.clientHeight + 2,
        wrapW: Math.round(document.getElementById('wrap').getBoundingClientRect().width),
        toggle: !!document.querySelector('.rc-toggle'),
        hebrew: (document.querySelector('.bar-title').textContent || '').indexOf('פרק') >= 0,
      };
    });
    console.log('  ' + JSON.stringify(m));
    check(m.hScroll <= 0, 'no horizontal page scroll');
    check(m.toggle, 'Hide Questions toggle present');
    check(m.hebrew, 'Hebrew renders (charset correct)');
    if (width > 760) {
      check(m.side, 'passage and questions side by side');
      /* Whether it overflows depends on viewport height and this passage's
         length; what must hold is that it is bounded and scrolls on its own
         rather than growing the page. The short-viewport case below proves it. */
      check(m.pOverflowY === 'auto' && m.pBounded, 'passage is bounded and scrolls independently');
    } else {
      check(m.stacked, 'columns stack');
      check(m.wrapW <= width, 'wrap fits the viewport');
    }

    await page.click('.rc-toggle');
    const col = await page.evaluate(() => {
      const q = document.querySelector('.rc-questions');
      return {
        hidden: !q || getComputedStyle(q).display === 'none',
        h: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    check(col.hidden, 'toggle hides the questions column');
    check(col.h <= 0, 'no horizontal scroll while collapsed');
    await page.click('.rc-toggle');

    await page.screenshot({ path: '/tmp/shot-' + label + '.png' });

    await finishSection(page);
    await page.waitForSelector('.sect-intro', { timeout: 10000 });
    const cls = await page.evaluate(() => document.getElementById('wrap').className);
    check(cls.trim() === 'wrap', 'wrap narrows again off the reading section (got "' + cls + '")');

    await page.close();
  }

  /* Short viewport: the passage must actually overflow and scroll inside its
     own box, without the page itself growing a horizontal scrollbar. */
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 560 } });
    await page.goto('http://127.0.0.1:8731/exam.html');
    await page.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
    await page.click('.sim');
    for (let i = 0; i < 6; i++) {
      await page.waitForSelector('.sect-intro .btn', { timeout: 10000 });
      const title = (await page.textContent('.sect-intro h2')) || '';
      await page.click('.sect-intro .btn');
      if (title.indexOf('הנקרא') >= 0) break;
      await finishSection(page);
    }
    await page.waitForSelector('.rc-split', { timeout: 10000 });
    const r = await page.evaluate(() => {
      const p = document.querySelector('.rc-passage');
      const before = p.scrollTop;
      p.scrollTop = 200;
      return { overflows: p.scrollHeight > p.clientHeight + 2, moved: p.scrollTop > before,
               hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    console.log('\n=== short viewport 1280x560 ===\n  ' + JSON.stringify(r));
    check(r.overflows, 'passage overflows at a short viewport');
    check(r.moved, 'passage scrolls inside its own box');
    check(r.hScroll <= 0, 'still no horizontal page scroll');
    await page.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nAll layout checks passed.\n' : '\n' + fail + ' FAILED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
