/* Browser checks for the three trainer additions: editing a saved mnemonic,
   the sentence-completion format of the quiz, and adopting a course hook from
   the vocabulary tab.  Start serve.js first, then: node features-ui.test.js */
const { chromium } = require('playwright-core');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FIXTURE = require('./fixtures/cards.json');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  let fail = 0;
  const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };

  /* Seed with words the course bank really has completion questions for, so
     the completion format has something to serve. */
  const seeded = {};
  for (const c of FIXTURE.cards) {
    seeded[c.word] = {
      word: c.word, meaning: c.meaning,
      mnemonic: c.noMnemonic ? '' : 'סימן ישן עבור ' + c.word,
      ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0,
    };
  }
  const bank = require('./course-bank.json');
  const extra = bank.filter((q) => q.v && q.v.length === 1).slice(0, 40);
  for (const q of extra) {
    const w = q.v[0];
    if (seeded[w]) continue;
    seeded[w] = { word: w, meaning: 'פירוש לבדיקה', mnemonic: 'סימן לבדיקה עבור ' + w,
                  ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0 };
  }

  for (const [label, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (e) => { fail++; console.log('  PAGE ERROR: ' + e.message); });
    await page.addInitScript((d) => { try { localStorage.setItem('amirnet.cards', JSON.stringify(d)) } catch (e) {} }, seeded);
    await page.goto('http://127.0.0.1:8731/exam.html');
    await page.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
    console.log('\n=== ' + label + ' ' + width + 'x' + height + ' ===');

    await page.click('#tab-trainer');
    await page.waitForSelector('#pane-trainer .pick', { timeout: 15000 });
    const modes = await page.$$eval('#pane-trainer .pick button', (b) => b.map((x) => x.textContent.trim()));
    check(modes.length === 3, 'three trainer modes (' + JSON.stringify(modes) + ')');

    // ---------- 1. the library: edit a saved mnemonic ----------
    await page.click('#pane-trainer .pick button:nth-child(3)');
    await page.waitForSelector('#libSearch');
    const before = await page.$$eval('#pane-trainer .card', (c) => c.length);
    check(before > 5, before + ' saved mnemonics listed');

    await page.fill('#libSearch', 'accuracy');
    await page.waitForFunction(() => document.querySelectorAll('#pane-trainer .card').length <= 2);
    const filtered = await page.$$eval('#pane-trainer .card .en', (e) => e.map((x) => x.textContent.trim()));
    check(filtered.includes('accuracy'), 'search narrows to the word typed (' + JSON.stringify(filtered) + ')');

    await page.click('#pane-trainer .card .btn');           // ערוך
    await page.waitForSelector('#libEdit');
    const loaded = await page.inputValue('#libEdit');
    check(loaded.indexOf('סימן ישן') >= 0, 'the editor opens on the existing mnemonic');

    await page.fill('#libEdit', 'סימן חדש לגמרי');
    const btns = await page.$$('#pane-trainer .card .row .btn');
    await btns[0].click();                                   // שמור
    await page.waitForFunction(() => !document.querySelector('#libEdit'));
    const after = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('amirnet.cards')).accuracy } catch (e) { return null }
    });
    check(after && after.mnemonic === 'סימן חדש לגמרי', 'the rewrite is persisted');
    check(after && after.meaning === 'דיוק, מדויקות', 'editing the hook keeps the meaning');
    check(after && after.ease === 2.5, 'editing the hook keeps the review schedule');

    // clearing removes only the hook
    await page.click('#pane-trainer .card .btn');
    await page.waitForSelector('#libEdit');
    const btns2 = await page.$$('#pane-trainer .card .row .btn');
    await btns2[2].click();                                  // מחק את הסימן
    await page.waitForTimeout(250);
    const cleared = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('amirnet.cards')).accuracy } catch (e) { return null }
    });
    check(cleared && !cleared.mnemonic, 'clearing removes the hook');
    check(cleared && cleared.meaning === 'דיוק, מדויקות', 'clearing keeps the card itself');

    // ---------- 2. the completion format of the quiz ----------
    await page.click('#pane-trainer .pick button:nth-child(2)');
    await page.waitForSelector('#quizStart');
    const fmts = await page.$$eval('#pane-trainer .pick', (gs) =>
      Array.from(gs[1].querySelectorAll('button')).map((b) => ({ t: b.textContent.trim(), off: b.disabled })));
    check(fmts.length === 2, 'the quiz offers two formats (' + JSON.stringify(fmts.map((f) => f.t)) + ')');
    const avail = Number((fmts[1].t.match(/\((\d+)\)/) || [])[1] || 0);
    check(avail > 0 && !fmts[1].off, avail + ' completion questions exist for the learned words');

    /* `.pick` groups sit among other divs, so nth-of-type counts the wrong
       siblings; take the groups by handle. Group 0 is the mode switch, group 1
       the format choice. */
    const fmtGroup = (await page.$$('#pane-trainer .pick'))[1];
    await (await fmtGroup.$$('button'))[1].click();
    /* The first p.muted is the tab's own header line, so test them all. */
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('#pane-trainer p.muted'))
        .some((e) => /השלמת משפטים אמיתיות/.test(e.textContent)));
    await page.click('#quizStart');
    await page.waitForSelector('.qbox .opt');
    const q = await page.evaluate(() => {
      const box = document.querySelector('.qbox');
      return {
        prompt: box.querySelector('.qtext').textContent.trim(),
        promptDir: getComputedStyle(box.querySelector('.qtext')).direction,
        optDir: getComputedStyle(box.querySelector('.opt .v')).direction,
        ask: box.querySelector('p.muted').textContent.trim(),   // inside .qbox there is only one
        n: box.querySelectorAll('.opt').length,
        hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    console.log('  completion: "' + q.prompt.slice(0, 70) + '"');
    check(/_{3,}/.test(q.prompt), 'the stem is a real completion sentence with a blank');
    check(q.promptDir === 'ltr' && q.optDir === 'ltr', 'both sides render LTR');
    check(q.ask.indexOf('משלימה את המשפט') >= 0, 'the prompt asks for the completing word');
    check(q.n === 4, 'four options');
    check(q.hScroll <= 0, 'no horizontal scroll');

    /* The answer must be a word that was actually learned. */
    const learned = await page.evaluate(() => {
      const box = document.querySelector('.qbox');
      const opts = Array.from(box.querySelectorAll('.opt .v')).map((v) => v.textContent.trim().toLowerCase());
      const saved = JSON.parse(localStorage.getItem('amirnet.cards') || '{}');
      return opts.some((o) => saved[o]);
    });
    check(learned, 'the question turns on a word from the learned set');

    // ---------- 3. adopting a course hook from the vocabulary tab ----------
    await page.click('#tab-vocab');
    await page.waitForSelector('#vocabSearch');

    /* The "only what the course teaches" filter must actually narrow the list. */
    const allRows = await page.$$eval('#vocabList .card', (c) => c.length);
    const scope = (await page.$$('#pane-vocab .pick'))[0];
    await (await scope.$$('button'))[1].click();
    await page.waitForTimeout(300);
    const taughtRows = await page.$$eval('#vocabList .card', (c) => c.length);
    const trivial = await page.$$eval('#vocabList .card .en', (e) =>
      e.map((x) => x.textContent.trim()).filter((w) => ['so', 'but', 'because', 'although'].includes(w)).length);
    /* The taught view is not a subset of the corpus list — it is the course's
       own vocabulary, most of which the corpus never had — so it is larger.
       What must hold is that every row in it carries something taught. */
    const allTaught = await page.$$eval('#vocabList .card', (cs) =>
      cs.every((c) => c.querySelector('.expl') || c.children.length > 1));
    console.log('  vocab scope: ' + allRows + ' -> ' + taughtRows);
    check(taughtRows > allRows, 'the taught view spans the whole course vocabulary');
    check(allTaught, 'every row in the taught view carries a meaning or a hook');
    check(trivial === 0, 'so/but/because drop out of the taught view');
    await (await scope.$$('button'))[0].click();
    await page.waitForTimeout(200);
    await page.waitForFunction(() => document.querySelectorAll('#vocabList .expl').length > 0, { timeout: 15000 });
    const vocab = await page.evaluate(() => {
      const card = document.querySelector('#vocabList .card:has(.expl)') ||
                   document.querySelector('#vocabList .expl').closest('.card');
      return {
        word: card.querySelector('.en').textContent.trim(),
        eyebrow: card.querySelector('.expl .eyebrow').textContent.trim(),
        hasBtn: !!card.querySelector('.expl .btn'),
      };
    });
    console.log('  vocab row: ' + JSON.stringify(vocab));
    check(vocab.eyebrow.indexOf('הקורס מלמד') >= 0, 'the course hook is shown in the vocabulary tab');
    check(vocab.hasBtn, 'the hook can be adopted from there');

    await page.evaluate(() => {
      const card = document.querySelector('#vocabList .expl').closest('.card');
      card.querySelector('.expl .btn').click();
    });
    await page.waitForTimeout(300);
    const adopted = await page.evaluate((w) => {
      try {
        const c = JSON.parse(localStorage.getItem('amirnet.cards'))[w];
        return c ? { has: !!c.mnemonic, src: c.source, due: c.due > 0 } : null;
      } catch (e) { return null }
    }, vocab.word);
    check(adopted && adopted.has, 'adopting writes the hook to the card');
    check(adopted && adopted.src === 'course', 'the adopted hook is credited to the course');
    check(adopted && adopted.due, 'the adopted word enters the review queue');

    await page.screenshot({ path: '/tmp/feat-' + label + '.png' });
    await page.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nAll feature checks passed.\n' : '\n' + fail + ' FAILED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
