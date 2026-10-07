/* Nothing may write to a card in place.
 *
 * Cards that came from the app's storage are frozen document snapshots, and
 * this whole script runs under "use strict", where a write to a frozen object
 * throws. This lifts the scheduler and the clone helper out of exam.html and
 * runs them against frozen input, which is what the real app hands them.
 *
 * node frozen.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'exam.html'), 'utf8');
function lift(from, to) {
  const a = html.indexOf(from), b = html.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('could not lift ' + from);
  return html.slice(a, b);
}
const src = lift('var DAY=86400000;', '/* ---------- picking the next word ----------');
const api = new Function('"use strict";' + src + '\n;return {schedule, newCard, cloneCard};')();

let fail = 0;
const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };

const frozenCard = () => Object.freeze({
  word: 'accuracy', meaning: 'דיוק, מדויקות', mnemonic: 'סימן ישן',
  ease: 2.5, interval: 2, reps: 2, lapses: 1, due: Date.now() - 1000,
});

console.log('=== the clone helper ===');
const f = frozenCard();
const c1 = api.cloneCard(f);
check(Object.isFrozen(f), 'the source really is frozen (otherwise this test proves nothing)');
check(!Object.isFrozen(c1), 'the copy is writable');
check(c1 !== f, 'the copy is a different object');
check(c1.word === f.word && c1.meaning === f.meaning && c1.ease === f.ease, 'every field survives the copy');
c1.mnemonic = 'נכתב';
check(c1.mnemonic === 'נכתב', 'writing to the copy works');
check(f.mnemonic === 'סימן ישן', 'the source is untouched');
check(api.cloneCard(null).word === '', 'a missing card yields a fresh one rather than throwing');

console.log('\n=== the scheduler against frozen input ===');
const before = frozenCard();
let out;
try { out = api.schedule(before, true); }
catch (e) { fail++; console.log('  FAIL: schedule threw on a frozen card — ' + e.message); }
if (out) {
  check(out !== before, 'it returns a new object rather than its argument');
  check(before.reps === 2 && before.interval === 2, 'the frozen input is not modified');
  check(out.reps === 3, 'the copy advanced (reps ' + before.reps + ' -> ' + out.reps + ')');
  check(out.interval > before.interval, 'the interval moved out (' + before.interval + ' -> ' + out.interval + ')');
  check(out.due > Date.now(), 'the copy is due in the future');
}

let miss;
try { miss = api.schedule(frozenCard(), false); }
catch (e) { fail++; console.log('  FAIL: a miss threw on a frozen card — ' + e.message); }
if (miss) {
  check(miss.interval === 1, 'a miss on a frozen card still comes back tomorrow');
  check(miss.lapses === 2, 'a miss on a frozen card still counts a lapse');
}

/* Recognition answers come from the quiz, which is the path that broke. */
let rec;
try { rec = api.schedule(frozenCard(), true, true); }
catch (e) { fail++; console.log('  FAIL: a recognition answer threw — ' + e.message); }
if (rec) check(rec.ease === 2.5, 'recognition still leaves ease alone');

console.log('\n=== the source has no in-place writes left ===');
/* A card arriving from storage must be copied before anything writes to it. */
const guarded = [
  ['loadCards', /out\[v\.word\]=cloneCard\(v\)/],
  ['schedule', /var c=cloneCard\(card\|\|newCard\(""\)\)/],
  ['saveHook', /var c=cloneCard\(cards\[word\]\|\|newCard\(word\)\)/],
  ['adoptCourseHook', /var c=cloneCard\(cards\[word\]\|\|newCard\(word\)\)/],
];
guarded.forEach(([name, re]) => check(re.test(html), `${name} copies before it writes`));
check(!/if\(v&&v\.word\) out\[v\.word\]=v;/.test(html), 'loadCards no longer stores the snapshot body itself');

console.log(fail ? `\n${fail} FAILED\n` : '\nAll frozen-card checks passed.\n');
process.exit(fail ? 1 : 0);
