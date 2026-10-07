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

/**
 * A stand-in for the real store, with the two behaviours that matter:
 * snapshot bodies come back FROZEN, and a `data/users/<id>` subtree is visible
 * only to that id — a sibling's reads as empty and a write into it is refused,
 * exactly as the platform does it.
 *
 * `legacy` seeds the old shared `mnemonics` collection, so the migration out
 * of it can be exercised; `viewer` is who is holding the page.
 */
async function withFakeDb(browser, width, height, opts) {
  const o = opts || {};
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript((cfg) => {
    window.__writes = [];
    window.__refused = [];
    /* path -> { docId: body } */
    const store = { mnemonics: {} };
    (cfg.legacy || []).forEach((d) => { store.mnemonics[d.word] = d; });
    Object.keys(cfg.seedPrivate || {}).forEach((owner) => {
      const p = 'data/users/' + owner;
      store[p] = store[p] || {};
      (cfg.seedPrivate[owner] || []).forEach((d) => { store[p][d.word] = d; });
    });

    const mayTouch = (path) => {
      const m = /^data\/users\/([^/]+)/.exec(path);
      return !m || m[1] === cfg.viewer;          // only your own subtree
    };
    const col = (path) => ({
      path: path,
      get: () => {
        if (!mayTouch(path)) return Promise.resolve({ docs: [] });   // reads as empty
        const bag = store[path] || {};
        return Promise.resolve({
          docs: Object.keys(bag).map((k) => ({
            id: k,
            data: () => Object.freeze(JSON.parse(JSON.stringify(bag[k]))),
          })),
        });
      },
      doc: (k) => ({
        set: (obj) => {
          if (!mayTouch(path) || cfg.readOnly) {
            window.__refused.push({ path, k });
            return Promise.reject({ code: 'invalid_argument', message: 'refused' });
          }
          store[path] = store[path] || {};
          store[path][k] = obj;
          window.__writes.push({ path: path, id: k, word: obj.word, obj: obj });
          return Promise.resolve();
        },
        delete: () => {
          if (store[path]) delete store[path][k];
          window.__writes.push({ path: path, id: k, deleted: true });
          return Promise.resolve();
        },
      }),
    });
    window.__store = () => JSON.parse(JSON.stringify(store));
    window.claude = {
      use: (name) => Promise.resolve(
        name === 'db' ? { collection: col }
          : name === 'user' ? { id: () => Promise.resolve(cfg.viewer),
                                isOwner: () => cfg.owner === true }
            : null),
    };
  }, { legacy: o.legacy || null, seedPrivate: o.seedPrivate || {},
       viewer: o.viewer || 'u_owner', owner: o.owner !== false, readOnly: !!o.readOnly });
  return page;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  let fail = 0;
  const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };

  for (const [label, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
    const page = await withFakeDb(browser, width, height, { legacy: seed, viewer: 'u_owner', owner: true });
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
      (window.__writes || []).filter((w) => w.word === 'accuracy' && w.obj).map((w) => w.obj.mnemonic));
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
      const w = (window.__writes || []).filter((x) => x.obj && x.id === 'accuracy').pop();
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
      (window.__writes || []).forEach((w) => { if (w.obj) byWord[w.obj.word] = w.obj; });
      return Object.keys(byWord).filter((w) => byWord[w].reps >= 3).length;
    });
    console.log('    rescheduled: ' + rescheduled);
    check(rescheduled > 0, 'the quiz wrote an updated schedule for the words it tested');

    await page.screenshot({ path: '/tmp/dbpath-' + label + '.png' });
    await page.close();
  }

  /* ==================================================================
   * The whole point of the per-viewer path: two people, one page, and
   * neither one's work reaching the other.
   * ================================================================== */
  console.log('\n=== two viewers on the same page ===');
  {
    /* The owner has already migrated and saved. */
    const owner = await withFakeDb(browser, 1280, 900, {
      seedPrivate: { u_owner: seed }, viewer: 'u_owner', owner: true,
    });
    await owner.goto('http://127.0.0.1:8731/exam.html');
    await owner.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
    await owner.click('#tab-trainer');
    await owner.waitForSelector('#pane-trainer .pick', { timeout: 15000 });
    const ownerModes = await (await owner.$$('#pane-trainer .pick'))[0]
      .$$eval('button', (b) => b.map((x) => x.textContent.trim()));
    check(/\(12\)/.test(ownerModes[2]), 'the owner sees their own 12 saved hooks');
    const badge = await owner.textContent('#whoami');
    check(/מצב מנהל/.test(badge), 'the owner is marked as admin (' + badge.trim() + ')');
    const ownerNote = await owner.textContent('#pane-trainer');
    check(/נשמרת בחשבון שלך בלבד/.test(ownerNote), 'the owner is told their progress is private to them');
    await owner.close();

    /* The sister: same page, same store, a different id. */
    const guest = await withFakeDb(browser, 390, 844, {
      seedPrivate: { u_owner: seed }, viewer: 'u_sister', owner: false,
    });
    const guestErrors = [];
    guest.on('pageerror', (e) => guestErrors.push(e.message));
    await guest.goto('http://127.0.0.1:8731/exam.html');
    await guest.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
    const guestBadge = await guest.textContent('#whoami');
    check(!/מצב מנהל/.test(guestBadge), 'a guest is not shown as admin');

    await guest.click('#tab-trainer');
    await guest.waitForFunction(() => {
      const p = document.getElementById('pane-trainer');
      return p && !p.hidden && p.textContent.length > 20;
    }, { timeout: 15000 });
    const guestPane = await guest.textContent('#pane-trainer');
    check(!/סימן ישן עבור/.test(guestPane), "none of the owner's hooks appear for the guest");
    check(!/הסימנים שלי \(/.test(guestPane), 'the guest starts with no saved hooks of their own');

    /* She can still work, and what she saves lands in HER subtree. */
    await guest.click('#tab-vocab');
    await guest.waitForSelector('#vocabSearch');
    await guest.waitForFunction(() => document.querySelectorAll('#vocabList .expl').length > 0, { timeout: 15000 });
    const word = await guest.evaluate(() => {
      const card = document.querySelector('#vocabList .expl').closest('.card');
      card.querySelector('.expl .btn').click();
      return card.querySelector('.en').textContent.trim();
    });
    await guest.waitForTimeout(400);
    const hers = await guest.evaluate(() => (window.__writes || []).filter((w) => w.obj));
    console.log('    guest wrote: ' + JSON.stringify(hers.map((w) => w.path + '/' + w.id)));
    check(hers.length > 0, 'the guest can save her own work (' + word + ')');
    check(hers.every((w) => w.path === 'data/users/u_sister'),
      "everything she saves goes to her own subtree, never the owner's");
    const refused = await guest.evaluate(() => window.__refused || []);
    check(refused.length === 0, 'nothing she did was refused by the store');

    const ownersUntouched = await guest.evaluate(() => {
      const st = window.__store();
      return Object.keys(st['data/users/u_owner'] || {}).length;
    });
    check(ownersUntouched === 12, "the owner's 12 cards are untouched by her session");
    check(guestErrors.length === 0, 'no errors in the guest session');
    await guest.close();
  }

  /* ==================================================================
   * Someone admitted read-only: the page must say so, not fail silently.
   * ================================================================== */
  console.log('\n=== a read-only visitor ===');
  {
    const ro = await withFakeDb(browser, 390, 844, {
      seedPrivate: { u_view: seed.slice(0, 3) }, viewer: 'u_view', owner: false, readOnly: true,
    });
    const roErrors = [];
    ro.on('pageerror', (e) => roErrors.push(e.message));
    await ro.goto('http://127.0.0.1:8731/exam.html');
    await ro.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
    await ro.click('#tab-trainer');
    await ro.waitForSelector('#pane-trainer .pick', { timeout: 15000 });
    await ro.click('#pane-trainer .pick button:nth-child(3)');
    await ro.waitForSelector('#libSearch');
    await ro.click('#pane-trainer .card .btn');
    await ro.waitForSelector('#libEdit');
    await ro.fill('#libEdit', 'ניסיון כתיבה');
    const btns = await ro.$$('#pane-trainer .card .row .btn');
    await btns[0].click();
    await ro.waitForTimeout(600);
    check(roErrors.length === 0, 'a refused write does not throw');
    const note = await ro.textContent('#pane-trainer');
    check(/לקריאה בלבד/.test(note) || /בדפדפן הזה בלבד/.test(note),
      'the page tells a read-only visitor where their work is really going');
    await ro.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nAll database-path checks passed.\n' : '\n' + fail + ' FAILED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
