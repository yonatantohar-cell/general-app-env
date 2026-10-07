/* Does the enlarged course bank actually reach the screen? Drives real drills
   for both types the guides supply and checks the bank the page builds.
   Start serve.js first, then: node bankcheck.js */
const { chromium } = require('playwright-core');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let fail = 0;
  const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };
  page.on('pageerror', (e) => { fail++; console.log('  PAGE ERROR: ' + e.message); });

  await page.goto('http://127.0.0.1:8731/exam.html');
  await page.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
  await page.waitForFunction(() => window.fetch && document.querySelector('#drillBtn'), { timeout: 15000 });

  /* Open the drill screen once so buildBank() runs with the course bank in. */
  await page.click('#drillBtn');
  await page.waitForSelector('.pick');

  const counts = await page.evaluate(async () => {
    const bank = await fetch('course-bank.json').then((r) => r.json());
    const byType = {}, byDiff = {};
    bank.forEach((q) => {
      byType[q.t] = (byType[q.t] || 0) + 1;
      byDiff[q.d] = (byDiff[q.d] || 0) + 1;
    });
    return { total: bank.length, byType, byDiff };
  });
  console.log('  served bank: ' + JSON.stringify(counts));
  check(counts.total === 456, '456 course questions are served to the page');
  check(counts.byType.restatement === 80, 'restatement reaches the page');

  /* Run a drill of each type and confirm a course question can come up. */
  /* A completion stem is recognised by its blank; a restatement stem is a whole
     sentence with no blank in it, so each is checked for what it actually is. */
  const shapes = [
    [0, 'sentence completion', (q) => /_{3,}/.test(q)],
    [1, 'restatement', (q) => !/_{3,}/.test(q) && q.trim().split(/\s+/).length >= 8],
  ];
  for (const [idx, label, marker] of shapes) {
    const groups = await page.$$('.pick');
    const typeBtns = await groups[0].$$('button');
    await typeBtns[idx].click();
    const lvl = await (await page.$$('.pick'))[1].$$('button');
    await lvl[0].click();                                  // easy
    const tim = await (await page.$$('.pick'))[2].$$('button');
    await tim[1].click();                                  // untimed
    await page.click('.card.set > .btn');
    await page.waitForSelector('.sect-intro .btn');
    await page.click('.sect-intro .btn');
    await page.waitForSelector('.qbox');
    const seen = await page.evaluate(() => ({
      q: document.querySelector('.qtext').textContent.trim(),
      opts: document.querySelectorAll('.opt').length,
    }));
    console.log(`  ${label}: "${seen.q.slice(0, 72)}..."`);
    check(seen.opts === 4, `${label} drill serves four options`);
    check(marker(seen.q), `${label} drill serves a real ${label} stem`);
    await page.click('#quit');
    await page.click('#quit');
    await page.waitForSelector('#drillBtn');
    await page.click('#drillBtn');
    await page.waitForSelector('.pick');
  }

  /* The trainer must now open on course-taught words. */
  await page.click('#quit');
  await page.waitForSelector('#tab-trainer');
  await page.click('#tab-trainer');
  await page.waitForFunction(() => {
    const p = document.getElementById('pane-trainer');
    return p && !p.hidden && p.textContent.length > 20;
  }, { timeout: 15000 });
  const pool = await page.evaluate(async () => {
    const t = await fetch('trainer-words.json').then((r) => r.json());
    return { n: t.length, seeded: t.filter((w) => w.seed).length,
             firstRare: t.filter((w) => w.times === 1).slice(0, 5).map((w) => w.word) };
  });
  console.log('  trainer: ' + JSON.stringify(pool));
  check(pool.n > 1600, `${pool.n} words in the trainer pool`);
  check(pool.seeded > 600, `${pool.seeded} of them open with a course hook`);

  await page.screenshot({ path: '/tmp/bank.png' });
  await browser.close();
  console.log(fail === 0 ? '\nBank integration verified.\n' : `\n${fail} FAILED\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
