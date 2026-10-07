/* A visitor with no account and no permissions at all — someone who just
 * opened the link. `window.claude` is removed entirely, which is what a
 * signed-out viewer sees: no db, no sample, no user.
 *
 * The claim being tested is the one that matters for sharing: everything works
 * except asking Claude, and her progress survives closing the page.
 *
 * Start serve.js first, then: node guest.test.js
 */
const { chromium } = require('playwright-core');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  let fail = 0;
  const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };

  for (const [label, width, height] of [['phone', 390, 844], ['desktop', 1280, 900]]) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    /* No capabilities whatsoever. */
    await page.addInitScript(() => { try { delete window.claude } catch (e) { window.claude = undefined } });
    await page.goto('http://127.0.0.1:8731/exam.html');
    await page.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
    console.log('\n=== ' + label + ' ' + width + 'x' + height + ' (no account) ===');

    check(await page.evaluate(() => !window.claude), 'the page really has no capabilities');
    const sims = await page.$$eval('.sim', (s) => s.length);
    check(sims === 20, 'all 20 simulations are listed (' + sims + ')');

    // ---------- a full drill, scored, with the hints ----------
    await page.click('#drillBtn');
    await page.waitForSelector('.pick');
    const groups = await page.$$('.pick');
    await (await groups[2].$$('button'))[1].click();          // untimed
    await page.click('.card.set > .btn');
    await page.waitForSelector('.sect-intro .btn');
    await page.click('.sect-intro .btn');
    await page.waitForSelector('.qbox');
    const n = (await page.$$('.dot')).length;
    for (let i = 0; i < n; i++) {
      const dots = await page.$$('.dot');
      await dots[i].click();
      const opts = await page.$$('.qbox .opt');
      await opts[0].click();
    }
    const dots = await page.$$('.dot');
    await dots[dots.length - 1].click();
    await page.click('.nav > .btn');
    await page.waitForSelector('.score', { timeout: 10000 });
    const score = await page.textContent('.score .pct');
    check(/^\d+$/.test(score), 'the drill is scored (' + score + ')');
    await page.waitForFunction(() => document.querySelectorAll('.rev').length > 0, { timeout: 10000 });
    const hinted = await page.$$eval('.rev', (cs) =>
      cs.filter((c) => /איך אפשר היה לפתור/.test(c.textContent)).length);
    check(hinted > 0, 'the solving hints still appear (' + hinted + ' questions)');

    // ---------- the vocabulary, and adopting a course hook ----------
    await page.click('.score .row .btn');
    await page.waitForSelector('#tab-vocab');
    await page.click('#tab-vocab');
    await page.waitForSelector('#vocabSearch');
    await page.waitForFunction(() => document.querySelectorAll('#vocabList .expl').length > 0, { timeout: 15000 });
    const word = await page.evaluate(() => {
      const card = document.querySelector('#vocabList .expl').closest('.card');
      card.querySelector('.expl .btn').click();
      return card.querySelector('.en').textContent.trim();
    });
    await page.waitForTimeout(300);
    check(!!word, 'a course hook can be adopted without an account (' + word + ')');

    // ---------- the trainer says honestly what is missing ----------
    await page.click('#tab-trainer');
    await page.waitForFunction(() => {
      const p = document.getElementById('pane-trainer');
      return p && !p.hidden && p.textContent.length > 40;
    }, { timeout: 15000 });
    const pane = await page.textContent('#pane-trainer');
    check(/בדפדפן הזה בלבד/.test(pane), 'the page says the work is kept in this browser');
    /* The judging no longer needs a permission: it runs against the stored
       meanings. What must be true is that the loop is actually offered. */
    check(/מה הפירוש/.test(pane), 'the trainer offers the full loop, not a permission notice');

    // the quiz and the library are reachable with no account
    const modeGroup = (await page.$$('#pane-trainer .pick'))[0];
    const modes = await modeGroup.$$eval('button', (b) => b.map((x) => x.textContent.trim()));
    check(modes.length === 3, 'all three trainer modes are offered (' + JSON.stringify(modes) + ')');

    // ---------- the FULL training loop, with no account ----------
    check(await page.evaluate(() => typeof Judge !== 'undefined'), 'the offline judge is loaded');
    await page.waitForSelector('#guessField', { timeout: 15000 });
    const shown = await page.textContent('#pane-trainer .card .en');
    const expected = await page.evaluate(async (w) => {
      const t = await fetch('trainer-words.json').then((r) => r.json());
      const e = t.filter((x) => x.word === w)[0];
      return e ? { he: e.he, hook: e.seed ? e.seed.hook : '' } : null;
    }, shown.trim());
    check(expected && expected.he, 'the word served has a stored meaning to judge against (' + shown.trim() + ')');

    /* Type the right answer. */
    await page.fill('#guessField', expected.he.split(',')[0].trim());
    await page.click('#pane-trainer .card .row .btn');
    await page.waitForFunction(() => /נכון|כמעט|לא נכון/.test(
      document.querySelector('#pane-trainer .card').textContent), { timeout: 10000 });
    const right = await page.evaluate(() => {
      const c = document.querySelector('#pane-trainer .card');
      return { badge: (c.querySelector('.verdict') || {}).textContent || '', text: c.textContent };
    });
    check(right.badge.trim() === 'נכון', 'a correct guess is marked correct, with no account (' + right.badge + ')');
    check(/בלי חיבור ל-Claude/.test(right.text), 'the page says how the check was made');
    check(right.text.indexOf(expected.he) >= 0, 'the real meaning is shown');
    if (expected.hook) check(right.text.indexOf(expected.hook.slice(0, 20)) >= 0,
      "the course's own hook is offered as the memory aid");

    /* Save it and confirm the card was written. */
    const saveBtns = await page.$$('#pane-trainer .card .row .btn');
    await saveBtns[0].click();
    await page.waitForTimeout(300);
    const saved = await page.evaluate((w) => {
      try { return JSON.parse(localStorage.getItem('amirnet.cards'))[w] } catch (e) { return null }
    }, shown.trim());
    check(saved && saved.meaning === expected.he, 'the judged word is saved with its meaning');
    check(saved && saved.due > 0, 'and scheduled for review');

    /* A wrong guess, then the correction the local judge needs to be honest. */
    await page.waitForSelector('#guessField', { timeout: 10000 });
    await page.fill('#guessField', 'משהו שאינו קשור בכלל');
    await page.click('#pane-trainer .card .row .btn');
    await page.waitForFunction(() => /בעצם צדקתי/.test(
      document.querySelector('#pane-trainer').textContent), { timeout: 10000 });
    check(true, 'a wrong guess offers the "I was actually right" correction');
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#pane-trainer button'))
        .find((x) => x.textContent.trim() === 'בעצם צדקתי');
      b.click();
    });
    await page.waitForFunction(() => /סימנת שצדקת/.test(
      document.querySelector('#pane-trainer').textContent), { timeout: 10000 });
    check(true, 'the correction is accepted and changes the verdict');

    // ---------- CLOSE THE PAGE AND COME BACK ----------
    await page.close();
    const again = await ctx.newPage();
    const errors2 = [];
    again.on('pageerror', (e) => errors2.push(e.message));
    await again.addInitScript(() => { try { delete window.claude } catch (e) { window.claude = undefined } });
    await again.goto('http://127.0.0.1:8731/exam.html');
    await again.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });

    const kept = await again.evaluate((w) => {
      let cards = {}, history = {};
      try { cards = JSON.parse(localStorage.getItem('amirnet.cards') || '{}') } catch (e) {}
      try { history = JSON.parse(localStorage.getItem('amirnet.history') || '{}') } catch (e) {}
      return { card: cards[w] || null, runs: Object.keys(history).length };
    }, word);
    check(kept.card && kept.card.mnemonic, 'the adopted hook survived closing the page');
    check(kept.runs > 0, 'the drill result survived too (' + kept.runs + ' recorded)');

    await again.click('#tab-trainer');
    await again.waitForSelector('#pane-trainer .pick', { timeout: 15000 });
    const backModes = await (await again.$$('#pane-trainer .pick'))[0]
      .$$eval('button', (b) => b.map((x) => x.textContent.trim()));
    check(/\(1\)/.test(backModes[2]), 'the saved hook is shown again after reopening (' + backModes[2] + ')');

    check(errors.length === 0 && errors2.length === 0,
      'no errors in either visit' + (errors.concat(errors2)[0] ? ': ' + errors.concat(errors2)[0] : ''));

    await again.screenshot({ path: '/tmp/guest-' + label + '.png' });
    await ctx.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nAll no-account checks passed.\n' : '\n' + fail + ' FAILED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
