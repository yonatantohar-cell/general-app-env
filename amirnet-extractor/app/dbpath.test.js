/* The storage path no other test covers.
 *
 * With the `db` capability granted, loadCards fills `cards` from document
 * snapshots, and snapshot bodies are FROZEN. Every test in this suite until now
 * ran the localStorage path, where load() returns fresh JSON.parse objects, so
 * nothing ever exercised a frozen card — and under "use strict" a write to one
 * throws, which is what made the save button look dead.
 *
 * This stubs window.claude.use("db") with a store that behaves like the real
 * one, frozen bodies and all, and drives the exact route the user took.
 *
 * Start serve.js first, then: node dbpath.test.js
 */
const { chromium } = require('playwright-core');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FIXTURE = require('./fixtures/cards.json');

const seed = FIXTURE.cards.slice(0, 12).map((c) => ({
  word: c.word, meaning: c.meaning,
  mnemonic: c.noMnemonic ? '' : 'סימן ישן עבור ' + c.word,
  ease: 2.5, interval: 2, reps: 2, lapses: 1, due: Date.now() - 1000,
}));

async function withFakeDb(browser, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript((docs) => {
    window.__writes = [];
    const store = {};
    docs.forEach((d) => { store[d.word] = d; });
    const col = () => ({
      get: () => Promise.resolve({
        docs: Object.keys(store).map((w) => ({
          id: w,
          /* Exactly what the real store hands back: a frozen body. */
          data: () => Object.freeze(JSON.parse(JSON.stringify(store[w]))),
        })),
      }),
      doc: (w) => ({
        set: (obj) => { window.__writes.push({ word: w, obj: obj }); store[w] = obj; return Promise.resolve(); },
        delete: () => { delete store[w]; return Promise.resolve(); },
      }),
    });
    window.claude = {
      use: (name) => Promise.resolve(name === 'db' ? { collection: col } : null),
    };
  }, seed);
  return page;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  let fail = 0;
  const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };

  for (const [label, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
    const page = await withFakeDb(browser, width, height);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:8731/exam.html');
    await page.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
    console.log('\n=== ' + label + ' ' + width + 'x' + height + ' ===');

    await page.click('#tab-trainer');
    await page.waitForSelector('#pane-trainer .pick', { timeout: 15000 });
    const modeGroup = (await page.$$('#pane-trainer .pick'))[0];
    const modes = await modeGroup.$$eval('button', (b) => b.map((x) => x.textContent.trim()));
    check(modes.length === 3, 'the trainer loaded from the database (' + JSON.stringify(modes) + ')');

    // ---------- the route the user took ----------
    await page.click('#pane-trainer .pick button:nth-child(3)');     // הסימנים שלי
    await page.waitForSelector('#libSearch');
    await page.fill('#libSearch', 'accuracy');
    await page.waitForFunction(() => document.querySelectorAll('#pane-trainer .card').length <= 2);
    await page.click('#pane-trainer .card .btn');                     // ערוך
    await page.waitForSelector('#libEdit');
    await page.fill('#libEdit', 'סימן חדש אחרי עריכה');

    const before = errors.length;
    const btns = await page.$$('#pane-trainer .card .row .btn');
    await btns[0].click();                                            // שמור
    await page.waitForTimeout(600);

    const thrown = errors.slice(before);
    if (thrown.length) console.log('    threw: ' + thrown[0].slice(0, 110));
    check(thrown.length === 0, 'saving does not throw');

    const closed = await page.evaluate(() => !document.querySelector('#libEdit'));
    check(closed, 'the editor closes after saving');

    const written = await page.evaluate(() =>
      (window.__writes || []).filter((w) => w.word === 'accuracy').map((w) => w.obj.mnemonic));
    console.log('    writes for accuracy: ' + JSON.stringify(written));
    check(written.includes('סימן חדש אחרי עריכה'), 'the new text reached the store');

    const shown = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('#pane-trainer .card'))
        .find((c) => (c.querySelector('.en') || {}).textContent === 'accuracy');
      return card ? card.textContent : '';
    });
    check(shown.indexOf('סימן חדש אחרי עריכה') >= 0, 'the list shows the rewritten hook');

    // ---------- clearing a hook, same path ----------
    await page.click('#pane-trainer .card .btn');
    await page.waitForSelector('#libEdit');
    const before2 = errors.length;
    const btns2 = await page.$$('#pane-trainer .card .row .btn');
    await btns2[2].click();                                           // מחק את הסימן
    await page.waitForTimeout(500);
    check(errors.length === before2, 'clearing a hook does not throw');
    const afterClear = await page.evaluate(() => {
      const w = (window.__writes || []).filter((x) => x.word === 'accuracy').pop();
      return w ? { has: !!w.obj.mnemonic, meaning: w.obj.meaning } : null;
    });
    check(afterClear && !afterClear.has, 'the cleared hook is written out');
    check(afterClear && afterClear.meaning === 'דיוק, מדויקות', 'clearing keeps the meaning');

    // ---------- a quiz, which reschedules every card it touched ----------
    await page.click('#pane-trainer .pick button:nth-child(2)');
    await page.waitForSelector('#quizStart');
    const before3 = errors.length;
    await page.click('#quizStart');
    await page.waitForSelector('.qbox .opt');
    const n = (await page.$$('.qdot')).length;
    for (let i = 0; i < n; i++) {
      const dots = await page.$$('.qdot');
      await dots[i].click();
      const opts = await page.$$('.qbox .opt');
      await opts[i % opts.length].click();
    }
    await page.click('#quizFinish');
    await page.waitForSelector('.quiz-score', { timeout: 10000 });
    await page.waitForTimeout(400);
    const thrown3 = errors.slice(before3);
    if (thrown3.length) console.log('    threw: ' + thrown3[0].slice(0, 110));
    check(thrown3.length === 0, 'finishing a quiz does not throw');
    const rescheduled = await page.evaluate(() => {
      const byWord = {};
      (window.__writes || []).forEach((w) => { byWord[w.word] = w.obj; });
      return Object.keys(byWord).filter((w) => byWord[w].reps >= 3).length;
    });
    console.log('    rescheduled: ' + rescheduled);
    check(rescheduled > 0, 'the quiz wrote an updated schedule for the words it tested');

    await page.screenshot({ path: '/tmp/dbpath-' + label + '.png' });
    await page.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nAll database-path checks passed.\n' : '\n' + fail + ' FAILED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
