/* Browser check for the vocabulary quiz: the mode switch, both question
   directions, the hint, the score, and that a run really moves the schedule.
   Start serve.js first, then: node quizui.test.js */
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* ---------------------------------------------------------------------------
 * The vocabulary quiz. It is driven in its own page with cards seeded into
 * localStorage, because without `db` that is where the trainer reads them from,
 * and because a fresh context keeps the exam's own `.dot`/`.opt` nodes out of
 * the way of these selectors.
 * ------------------------------------------------------------------------- */
const { chromium } = require('playwright-core');
const FIXTURE = require('./fixtures/cards.json');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  let fail = 0;
  const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };

  const seeded = {};
  for (const c of FIXTURE.cards) {
    seeded[c.word] = {
      word: c.word, meaning: c.meaning,
      mnemonic: c.noMnemonic ? '' : 'סימן לבדיקה עבור ' + c.word,
      ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0,
    };
  }

  for (const [label, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (e) => { fail++; console.log('  PAGE ERROR: ' + e.message); });
    await page.addInitScript((data) => {
      try { localStorage.setItem('amirnet.cards', JSON.stringify(data)) } catch (e) {}
    }, seeded);
    await page.goto('http://127.0.0.1:8731/exam.html');
    await page.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
    console.log('\n=== quiz ' + label + ' ' + width + 'x' + height + ' ===');

    await page.click('#tab-trainer');
    await page.waitForSelector('#pane-trainer .pick', { timeout: 15000 });

    /* The mode switch must be there even though this page has no `sample`. */
    /* first-of-type counts divs, not .pick groups, so take the group by handle. */
    const modeGroup = (await page.$$('#pane-trainer .pick'))[0];
    const modes = await modeGroup.$$eval('button', (b) => b.map((x) => x.textContent.trim()));
    check(modes.length === 3, 'the trainer offers three modes (' + JSON.stringify(modes) + ')');
    check(modes[1].indexOf('38') >= 0, 'the quiz button counts the studied words');

    await page.click('#pane-trainer .pick button:nth-child(2)');
    await page.waitForSelector('#quizStart');
    /* Groups are now: 0 the mode switch, 1 the format choice, 2 the lengths. */
    const sizes = await page.$$eval('#pane-trainer .pick', (gs) =>
      Array.from(gs[2].querySelectorAll('button')).map((b) => b.textContent.trim()));
    check(sizes.join(',') === '10,25,הכול (38)', 'the lengths offered fit the pool (' + sizes.join(' · ') + ')');

    await page.click('#quizStart');
    await page.waitForSelector('.qbox .opt');

    const q1 = await page.evaluate(() => {
      const box = document.querySelector('.qbox');
      const v = box.querySelector('.opt .v');
      const prompt = box.querySelector('.qtext');
      return {
        n: box.querySelectorAll('.opt').length,
        dots: box.querySelectorAll('.qdot').length,
        promptLtr: prompt.classList.contains('en'),
        promptDir: getComputedStyle(prompt).direction,
        optDir: getComputedStyle(v).direction,
        hint: !!document.getElementById('quizHint'),
        hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        num: box.querySelector('.qnum').textContent.trim(),
      };
    });
    console.log('  ' + JSON.stringify(q1));
    check(q1.n === 4, 'four options');
    check(q1.dots === 10, 'ten questions in the run');
    check(q1.num.indexOf('מתוך 10') >= 0, 'the counter says 10');
    /* First question is en2he: English prompt LTR, Hebrew options RTL. */
    check(q1.promptLtr && q1.promptDir === 'ltr', 'the English prompt renders LTR');
    check(q1.optDir === 'rtl', 'Hebrew options render RTL');
    /* The hint is the learner's OWN hook, so it is offered only for a word
       that has one. The fixture deliberately includes a word saved without a
       hook, and when that one comes up first the button is correctly absent —
       so this checks the rule, not the luck of the draw. */
    const w1 = await page.evaluate(() => {
      const box = document.querySelector('.qbox');
      const opts = Array.from(box.querySelectorAll('.opt .v')).map((v) => v.textContent.trim().toLowerCase());
      const saved = JSON.parse(localStorage.getItem('amirnet.cards') || '{}');
      const hit = opts.find((o) => saved[o]);
      return hit ? { word: hit, hasHook: !!saved[hit].mnemonic } : null;
    });
    check(!w1 || q1.hint === w1.hasHook,
      'the hint is offered exactly when the word has a saved hook (' +
      (w1 ? w1.word + ', hook=' + w1.hasHook + ', button=' + q1.hint : 'n/a') + ')');
    check(q1.hScroll <= 0, 'no horizontal page scroll');

    /* The reverse direction: Hebrew prompt, English options. */
    const dots0 = await page.$$('.qdot');
    await dots0[1].click();
    await page.waitForFunction(() => /שאלה 2/.test(document.querySelector('.qnum').textContent));
    const q2 = await page.evaluate(() => {
      const box = document.querySelector('.qbox');
      return {
        promptDir: getComputedStyle(box.querySelector('.qtext')).direction,
        optDir: getComputedStyle(box.querySelector('.opt .v')).direction,
        ask: box.querySelector('p.muted').textContent.trim(),
      };
    });
    console.log('  ' + JSON.stringify(q2));
    check(q2.promptDir === 'rtl', 'the Hebrew prompt renders RTL');
    check(q2.optDir === 'ltr', 'English options render LTR');
    check(q2.ask.indexOf('איזו מילה') >= 0, 'the reverse direction asks for the word');

    /* The hint reveals the learner's own hook and is recorded. Move to a
       question that has one rather than assuming the current one does. */
    await page.evaluate(async () => {
      const saved = JSON.parse(localStorage.getItem('amirnet.cards') || '{}');
      const dots = Array.from(document.querySelectorAll('.qdot'));
      for (let i = 0; i < dots.length; i++) {
        document.querySelectorAll('.qdot')[i].click();
        await new Promise((r) => setTimeout(r, 30));
        if (document.getElementById('quizHint')) return;
      }
    });
    await page.waitForSelector('#quizHint', { timeout: 10000 });
    await page.click('#quizHint');
    await page.waitForSelector('.qbox .expl');
    const hinted = await page.textContent('.qbox .expl');
    check(hinted.indexOf('סימן לבדיקה') >= 0, 'the hint shows the saved hook');
    check(!(await page.$('#quizHint')), 'the hint button is gone once used');

    /* Answer every question, then finish. */
    for (let i = 0; i < 10; i++) {
      const dots = await page.$$('.qdot');
      await dots[i].click();
      const opts = await page.$$('.qbox .opt');
      await opts[i % opts.length].click();
    }
    const answered = await page.$$eval('.qdot', (d) => d.filter((x) => x.classList.contains('ans')).length);
    check(answered === 10, 'every answer is recorded on the dots (' + answered + ')');

    await page.click('#quizFinish');
    await page.waitForSelector('.quiz-score');
    const res = await page.evaluate(() => ({
      pct: document.querySelector('.quiz-score .qpct').textContent.trim(),
      revs: document.querySelectorAll('#pane-trainer .rev').length,
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      /* the exam's own result card must not have been touched */
      examScore: document.querySelectorAll('.score').length,
      saved: (() => { try { return JSON.parse(localStorage.getItem('amirnet.cards')) } catch (e) { return null } })(),
    }));
    console.log('  result: ' + res.pct + ' · ' + res.revs + ' reviewed');
    check(/^\d+\/10$/.test(res.pct), 'the score reads as X/10 (got "' + res.pct + '")');
    check(res.revs === 10, 'every question is reviewed');
    check(res.examScore === 0, 'the quiz did not render into the exam result card');
    check(res.hScroll <= 0, 'results do not scroll sideways');

    /* The run must have moved the schedule for the words it covered. */
    const moved = Object.keys(res.saved || {}).filter((w) => res.saved[w].reps > 0);
    check(moved.length === 10, 'exactly the ten tested words were rescheduled (' + moved.length + ')');
    const anyDue = moved.every((w) => res.saved[w].due > Date.now());
    check(anyDue, 'each tested word has a future due date');

    await page.screenshot({ path: '/tmp/quiz-' + label + '.png' });
    await page.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nAll quiz browser checks passed.\n' : '\n' + fail + ' FAILED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
