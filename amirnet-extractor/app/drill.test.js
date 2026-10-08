/* Browser check for single-section practice and the trainer tab.
   Start serve.js first, then: node drill.test.js */
const { chromium } = require('playwright-core');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

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

    // --- single-section drill, untimed ---
    await page.click('#drillBtn');
    await page.waitForSelector('.pick');
    const groups = await page.$$('.pick');
    check(groups.length === 3, 'three choice groups (type, level, timing)');

    /* `.pick` divs sit among other divs, so nth-of-type would index the wrong
       siblings; pick the groups by handle and click inside each. */
    async function choose(groupIdx, btnIdx) {
      const gs = await page.$$('.pick');
      const bs = await gs[groupIdx].$$('button');
      await bs[btnIdx].click();
    }
    await choose(0, 1);   // restatement
    await choose(1, 2);   // hard
    await choose(2, 1);   // untimed
    await page.click('.card.set > .btn');

    await page.waitForSelector('.sect-intro');
    const intro = await page.evaluate(() => ({
      big: document.querySelector('.sect-intro .big').textContent.trim(),
      body: document.querySelector('.sect-intro').textContent,
      sections: (document.querySelector('.sect-intro .eyebrow').textContent || ''),
    }));
    check(intro.big === '∞', 'untimed drill shows no clock on the intro (got "' + intro.big + '")');
    check(intro.body.indexOf('ללא הגבלת זמן') >= 0, 'intro says untimed');
    check(intro.sections.indexOf('מתוך 1') >= 0, 'the drill is a one-section run (got "' + intro.sections + '")');

    await page.click('.sect-intro .btn');
    await page.waitForSelector('.qbox');
    const run = await page.evaluate(() => ({
      timer: document.getElementById('timer').textContent.trim(),
      opts: document.querySelectorAll('.opt').length,
      dots: document.querySelectorAll('.dot').length,
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    console.log('  ' + JSON.stringify(run));
    check(run.timer === '∞', 'clock stays off during an untimed drill');
    check(run.opts >= 2, 'options rendered');
    check(run.dots >= 1, 'question navigation rendered');
    check(run.hScroll <= 0, 'no horizontal page scroll');

    // the clock really is not running
    await page.waitForTimeout(1600);
    const stillOff = await page.evaluate(() => document.getElementById('timer').textContent.trim());
    check(stillOff === '∞', 'no tick fired after 1.6s');

    // finish and land on results
    const dots = await page.$$('.dot');
    await dots[dots.length - 1].click();
    await page.click('.nav > .btn');
    await page.waitForSelector('.score', { timeout: 10000 });
    const score = await page.evaluate(() => ({
      pct: document.querySelector('.score .pct').textContent.trim(),
      hasBand: !!document.querySelector('.score .muted'),
    }));
    check(/^\d+$/.test(score.pct), 'results show a score (got "' + score.pct + '")');

    // --- trainer tab renders without capabilities ---
    /* The score card's first .btn is "how is the score computed"; the one that
       navigates is the labelled back button. */
    await page.click('.score .row .btn');            // back to the list
    await page.waitForSelector('#tab-trainer');
    await page.click('#tab-trainer');
    await page.waitForFunction(
      () => { const p = document.getElementById('pane-trainer'); return p && !p.hidden && p.textContent.length > 20; },
      { timeout: 15000 });
    const tr = await page.evaluate(() => ({
      text: document.getElementById('pane-trainer').textContent.slice(0, 200),
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    console.log('  trainer: ' + JSON.stringify(tr.text.slice(0, 90)));
    // Served from a plain file server there is no window.claude, so the tab must
    // say the permission is missing rather than render a dead form.
    check(tr.text.indexOf('הרשאה') >= 0 || tr.text.indexOf('מאמן מילים') >= 0, 'trainer tab renders a real state');
    check(tr.hScroll <= 0, 'trainer tab does not scroll sideways');

    await page.screenshot({ path: '/tmp/drill-' + label + '.png' });
    await page.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nAll drill checks passed.\n' : '\n' + fail + ' FAILED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
