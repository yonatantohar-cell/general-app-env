const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  let fail = 0;
  const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m) } else console.log('  ok  : ' + m) };
  p.on('pageerror', e => { fail++; console.log('  PAGE ERROR: ' + e.message) });

  await p.goto('http://127.0.0.1:8731/exam.html');
  await p.waitForFunction(() => document.querySelectorAll('.sim').length > 0, { timeout: 15000 });
  // let the course fetch settle and the bank invalidate
  await p.waitForTimeout(1200);

  const res = await p.evaluate(() => {
    // drive the app's own loader rather than re-implementing it
    const btn = document.getElementById('drillBtn');
    btn.click();
    return new Promise(r => setTimeout(() => {
      const groups = document.querySelectorAll('.pick');
      r({ groups: groups.length });
    }, 300));
  });
  check(res.groups === 3, 'drill setup renders');

  // run many easy sentence-completion drills and look for a course item
  const found = await p.evaluate(async () => {
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
      document.getElementById('drillBtn').click();
      await new Promise(r => setTimeout(r, 40));
      const gs = document.querySelectorAll('.pick');
      gs[0].querySelectorAll('button')[0].click();            // sentence completion
      await new Promise(r => setTimeout(r, 40));
      document.querySelectorAll('.pick')[1].querySelectorAll('button')[0].click();  // easy
      await new Promise(r => setTimeout(r, 40));
      document.querySelector('.card.set > .btn').click();
      await new Promise(r => setTimeout(r, 60));
      document.querySelector('.sect-intro .btn').click();
      await new Promise(r => setTimeout(r, 60));
      document.querySelectorAll('.qbox .qtext').forEach(q => seen.add(q.textContent.trim()));
      document.getElementById('quit').click();
      document.getElementById('quit').click();
      await new Promise(r => setTimeout(r, 40));
    }
    return [...seen];
  });

  const courseStems = require('/home/user/general-app-env/amirnet-extractor/app/course-bank.json')
    .map(q => q.p.replace(/______/g, '').slice(0, 30));
  const hits = found.filter(f => courseStems.some(c => f.replace(/_/g, '').indexOf(c.slice(0, 25)) >= 0));
  console.log('  distinct questions served across 25 drills: ' + found.length);
  check(hits.length > 0, 'course sheet questions reach the drill (' + hits.length + ' seen)');
  if (hits.length) console.log('    e.g. ' + hits[0].slice(0, 70));

  await b.close();
  console.log(fail ? '\n' + fail + ' FAILED\n' : '\nCourse integration verified.\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1) });
