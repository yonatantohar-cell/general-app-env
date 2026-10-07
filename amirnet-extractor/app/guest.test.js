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
    check(/הרשאה/.test(pane), 'it says the judging feature needs a permission, rather than looking broken');

    // the quiz and the library are reachable with no account
    const modeGroup = (await page.$$('#pane-trainer .pick'))[0];
    const modes = await modeGroup.$$eval('button', (b) => b.map((x) => x.textContent.trim()));
    check(modes.length === 3, 'all three trainer modes are offered (' + JSON.stringify(modes) + ')');

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
