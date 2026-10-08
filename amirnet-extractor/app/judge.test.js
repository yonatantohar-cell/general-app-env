/* How often is the offline judge wrong, and in which direction?
 *
 * There are no real learner guesses to test against, so both error directions
 * are measured from the data itself:
 *
 *   FALSE NEGATIVE — the learner is right and is told they are wrong. Measured
 *   by feeding each word its own meaning, and each single term of that meaning
 *   on its own, which is what someone who knows the word actually types.
 *
 *   FALSE POSITIVE — the learner is wrong and is told they are right. Measured
 *   by feeding each word a DIFFERENT word's meaning, thousands of pairs.
 *
 * A false negative costs confidence; a false positive costs one repetition.
 * The matcher is tuned to prefer the second, and these numbers are what that
 * claim rests on.
 *
 * node judge.test.js
 */
const J = require('./judge.js');
const trainer = require('./trainer-words.json');

const glossed = trainer.filter((w) => w.he);
let fail = 0;
const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0') + '%';

console.log(`pool: ${trainer.length} words, ${glossed.length} with a stored meaning ` +
  `(${pct(glossed.length, trainer.length)}), ${trainer.filter((w) => w.seed).length} with a course hook\n`);

/* ---------------------------------------------------- false negatives --- */
console.log('=== the learner is right: is it accepted? ===');
let whole = 0, wholeOk = 0, single = 0, singleOk = 0, misses = [];
for (const w of glossed) {
  whole++;
  if (J.compare(w.he, w.he).verdict === 'correct') wholeOk++;
  for (const t of J.terms(w.he)) {
    single++;
    const v = J.compare(t, w.he).verdict;
    if (v === 'correct') singleOk++;
    else if (misses.length < 5) misses.push(`${w.word}: typed "${t}" against "${w.he}" -> ${v}`);
  }
}
console.log(`  the whole meaning typed back: ${wholeOk}/${whole} accepted (${pct(wholeOk, whole)})`);
console.log(`  one term of it typed alone  : ${singleOk}/${single} accepted (${pct(singleOk, single)})`);
misses.forEach((m) => console.log('    missed: ' + m));
check(wholeOk === whole, 'the exact meaning is always accepted');
check(singleOk / single > 0.98, 'a single correct term is almost always accepted');

/* A learner rarely types the dictionary form. These are the shapes that
   actually get typed, built from the stored meanings themselves. */
console.log('\n=== written a little differently ===');
const variants = (t) => [
  'ל' + t, 'ה' + t, 'ו' + t, 'ב' + t,              // with a leading particle
  t + '.', ' ' + t + ' ', t.replace(/ /g, '  '),    // punctuation and spacing
];
let vtot = 0, vok = 0;
for (const w of glossed) {
  const first = J.terms(w.he)[0];
  if (!first) continue;
  for (const v of variants(first)) {
    vtot++;
    if (J.compare(v, w.he).verdict === 'correct') vok++;
  }
}
console.log(`  ${vok}/${vtot} accepted (${pct(vok, vtot)})`);
check(vok / vtot > 0.95, 'ordinary variation in how it is typed is still accepted');

/* ---------------------------------------------------- false positives --- */
console.log('\n=== the learner is wrong: is it caught? ===');
/* Deterministic pairing so the number does not drift between runs. */
let pairs = 0, wrongCaught = 0, partialCount = 0, leaks = [];
for (let i = 0; i < glossed.length; i++) {
  const a = glossed[i];
  for (const step of [1, 7, 53, 211]) {
    const b = glossed[(i + step) % glossed.length];
    if (b.word === a.word) continue;
    /* Skip pairs the course itself glosses identically — those are synonyms,
       and calling that a wrong answer would be the test being wrong. */
    if (J.compare(b.he, a.he).matched && J.terms(a.he).some((t) => J.terms(b.he).includes(t))) continue;
    pairs++;
    const v = J.compare(b.he, a.he).verdict;
    if (v === 'wrong') wrongCaught++;
    else {
      if (v === 'partial') partialCount++;
      if (leaks.length < 5) leaks.push(`"${b.he}" accepted as ${a.word} ("${a.he}") -> ${v}`);
    }
  }
}
console.log(`  ${wrongCaught}/${pairs} rejected (${pct(wrongCaught, pairs)}), ` +
  `${partialCount} called "close" (${pct(partialCount, pairs)})`);
leaks.forEach((l) => console.log('    leaked: ' + l));
const falsePos = (pairs - wrongCaught) / pairs;
check(falsePos < 0.1, `another word's meaning is accepted only ${pct(pairs - wrongCaught, pairs)} of the time`);

/* ------------------------------------------------------------ the shape -- */
console.log('\n=== what the screen receives ===');
const withHook = glossed.find((w) => w.seed && w.seed.hook);
const noHook = glossed.find((w) => !w.seed);
check(J.judgeable(withHook), 'a glossed word is judgeable');
check(!J.judgeable({ word: 'x' }), 'a word with no stored meaning is not judgeable');
check(J.judge('x', 'משהו', { word: 'x' }) === null, 'and judging it returns nothing rather than guessing');

const good = J.judge(withHook.word, J.terms(withHook.he)[0], withHook);
check(good.verdict === 'correct', `a right answer reads correct (${withHook.word})`);
check(good.meaning === withHook.he, 'the real meaning is always returned');
check(good.mnemonic === withHook.seed.hook, "the course's own hook is offered, not an invented one");
check(good.by === 'local', 'the answer is marked as locally decided');

const bad = J.judge(noHook.word, 'משהו אחר לגמרי שאינו קשור', noHook);
check(bad.verdict === 'wrong', 'a wrong answer reads wrong');
check(bad.meaning === noHook.he, 'and still shows the real meaning');
check(bad.mnemonic === '', 'a word the course gives no hook for offers none');

['', '-', 'לא יודע', '?'].forEach((g) => {
  const j = J.judge(withHook.word, g, withHook);
  check(j.verdict === 'wrong' && /לא ניחשת/.test(j.note), `"${g || '(empty)'}" is treated as not knowing`);
});

console.log(fail ? `\n${fail} FAILED\n` : '\nAll judge checks passed.\n');
process.exit(fail ? 1 : 0);
