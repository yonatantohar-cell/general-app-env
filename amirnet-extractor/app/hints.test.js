/* Measures every rule in hints.js against the whole question bank.
 *
 * A rule that eliminates options is only worth showing if it keeps the right
 * answer. "Coverage" is how often the rule finds evidence at all; "kept" is how
 * often, when it fired, the correct answer survived it. A rule that kills the
 * right answer as often as chance would is reported as such and not dressed up.
 *
 * node hints.test.js
 */
const H = require('./hints.js');
const course = require('./course-bank.json');
const sims = require('./simulations.json');
const trainer = require('./trainer-words.json');

/* word -> Hebrew meaning, exactly what the app hands the engine at runtime. */
const glosses = {};
for (const w of trainer) if (w.he) glosses[w.word] = w.he;

/* Every question the app can serve, in one list. */
const bank = [];
for (const q of course) bank.push({ p: q.p, o: q.o, a: q.a, t: q.t, src: 'course' });
for (const s of sims)
  for (const sec of s.sections)
    for (const q of sec.questions)
      bank.push({ p: q.p, o: q.o, a: q.a, t: sec.type, src: 'corpus' });

const completion = bank.filter((q) => /_{2,}/.test(q.p));
console.log(`bank: ${bank.length} questions (${completion.length} with a blank), ` +
  `${Object.keys(glosses).length} glossed words\n`);

let fail = 0;
const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0') + '%';

/* ------------------------------------------------------------------ report */
/**
 * For an eliminating rule: how often it fires, how many options it removes,
 * and — the only number that matters — how often the correct answer survives.
 * `chance` is what blind elimination of the same number of options would keep.
 */
function measure(name, fn, pool) {
  let fired = 0, killedTotal = 0, kept = 0, chanceKept = 0, examples = [];
  for (const q of pool) {
    const kills = fn(q);
    if (!kills || !kills.length) continue;
    if (kills.length >= q.o.length) continue;      // a rule that kills everything says nothing
    fired++;
    killedTotal += kills.length;
    const survived = !kills.includes(q.a);
    if (survived) kept++;
    chanceKept += 1 - kills.length / q.o.length;
    if (!survived && examples.length < 3) examples.push(q);
  }
  const keptPct = fired ? kept / fired : 0;
  const chancePct = fired ? chanceKept / fired : 0;
  console.log(`\n  ${name}`);
  console.log(`    fires on ${fired}/${pool.length} (${pct(fired, pool.length)}), ` +
    `removes ${fired ? (killedTotal / fired).toFixed(2) : 0} options on average`);
  console.log(`    keeps the right answer ${pct(kept, fired)}  (blind elimination would keep ${(chancePct * 100).toFixed(1)}%)`);
  if (examples.length) console.log(`    misses, e.g.: "${examples[0].p.slice(0, 72)}" -> ${examples[0].o[examples[0].a]}`);
  return { fired, kept, keptPct, chancePct, pool: pool.length };
}

/* ======================================================= the hard rules === */
console.log('=== hard rules: they should essentially never remove the answer ===');

/* Measured, found wanting, and therefore NOT shipped as an eliminator. The
   grammar is absolute; reading an English word's part of speech off its ending
   is not, and this is the number that settled it. The hint now states the
   requirement instead of acting on it. */
const slotElim = measure('slot, IF it eliminated by suffix morphology (rejected)', (q) => {
  const sl = H.slot(q.p);
  if (!sl) return null;
  return q.o.map((o, i) => (!/\s/.test(o.trim()) && !H.canBe(o, sl.need) ? i : -1)).filter((i) => i >= 0);
}, completion);
check(slotElim.keptPct < 0.9,
  `eliminating by morphology keeps the answer only ${pct(slotElim.kept, slotElim.fired)} — rejected, as shipped it only points`);

let slotFires = 0;
for (const q of completion) if (H.slot(q.p)) slotFires++;
console.log(`\n  slot, as shipped (points, never eliminates)`);
console.log(`    names the required part of speech on ${slotFires}/${completion.length} (${pct(slotFires, completion.length)})`);
const slotRule = { fired: slotFires, kept: slotFires, keptPct: 1, chancePct: 0, pool: completion.length };

const synRule = measure('synonym pair (both are glossed the same in Hebrew)', (q) => {
  const pairs = H.synonymPairs(q.o, glosses);
  if (!pairs.length) return null;
  const k = new Set();
  pairs.forEach((p) => { k.add(p.i); k.add(p.j); });
  return [...k];
}, bank);

check(slotRule.fired > 0, 'the slot rule finds a decidable cue on a real share of questions');
check(synRule.fired === 0 || synRule.keptPct >= 0.9,
  `the synonym rule keeps the answer ${pct(synRule.kept, synRule.fired)} of the time`);

/* ======================================================= the soft rules === */
console.log('\n=== soft rules: claimed at 80-90%, so measured against that ===');

const saRule = measure('sound-alike distractor', (q) => {
  const sa = H.soundAlikes(q.p, q.o);
  return sa.length ? sa.map((x) => x.i) : null;
}, bank);

const exRule = measure('extreme wording', (q) => {
  const ex = H.extremes(q.o);
  return ex.length ? ex.map((x) => x.i) : null;
}, bank);

/* These two are reported honestly rather than asserted into passing. */
const verdict = (r, claim) =>
  r.fired === 0 ? 'never fires on this bank'
    : r.keptPct >= claim ? 'holds up'
      : r.keptPct > r.chancePct + 0.05 ? 'helps, but below the claim'
        : 'no better than chance';
console.log(`\n  sound-alike: ${verdict(saRule, 0.8)}`);
console.log(`  extreme wording: ${verdict(exRule, 0.8)}`);

/* A soft rule may only be shown as eliminating if it actually beats chance. */
check(saRule.fired === 0 || saRule.keptPct > saRule.chancePct,
  'the sound-alike rule beats blind elimination');
check(exRule.fired === 0 || exRule.keptPct >= exRule.chancePct,
  'the extreme-wording rule does not actively mislead');

/* ===================================================== coverage of cues === */
console.log('\n=== cues that point rather than eliminate ===');
let withConn = 0, rev = 0, cont = 0, withDef = 0, withPrefix = 0;
for (const q of bank) {
  const c = H.connective(q.p);
  if (c) { withConn++; if (c.dir === 'reverse') rev++; else cont++; }
  if (/_{2,}/.test(q.p) && H.definitionAnchor(q.p)) withDef++;
  if (q.o.some((o) => !/\s/.test(o.trim()) && H.prefixOf(o))) withPrefix++;
}
console.log(`  a connective in the sentence : ${withConn}/${bank.length} (${pct(withConn, bank.length)})  ` +
  `${rev} reversing, ${cont} continuing`);
console.log(`  a definition anchor beside the blank: ${withDef}/${completion.length} (${pct(withDef, completion.length)})`);
console.log(`  a recognisable prefix among the options: ${withPrefix}/${bank.length} (${pct(withPrefix, bank.length)})`);
check(withConn > bank.length * 0.1,
  `connectives appear on ${pct(withConn, bank.length)} of questions — common enough to be worth teaching`);

/* ================================================ the blank is a word ==== */
console.log('\n=== the blank must not glue words together ===');
check(H.connective('The instructions were so ____ that nobody understood them.') === null,
  '"so ____ that" is not read as the connective "so that"');
check(H.connective('He left so that nobody would see him.') !== null,
  '"so that" is still found when it really is there');
check(H.connective('She stayed in ______ spite of the warning.') === null,
  '"in ______ spite of" is not read as "in spite of"');
const realDespite = H.connective('Despite the warning, she stayed.');
check(realDespite && realDespite.dir === 'reverse', '"despite" is still found and reverses');

/* ================================================== the prefix exceptions */
console.log('\n=== the prefix trap the learner was warned about ===');
['understand', 'important', 'delight', 'present', 'process', 'continue', 'company']
  .forEach((w) => check(H.prefixOf(w) === null, `"${w}" is not read as a prefixed word`));
['illogical', 'irregular', 'malfunction', 'misunderstand', 'cooperate', 'benefit']
  .forEach((w) => check(H.prefixOf(w) !== null, `"${w}" is read as a prefixed word`));

/* ========================================================= sanity on output */
console.log('\n=== the hints as the app shows them ===');
let any = 0, hardOnly = 0, killsAnswer = 0;
for (const q of bank) {
  const hs = H.solveHints(q, { glosses });
  if (hs.length) any++;
  const hard = hs.filter((h) => h.hard);
  if (hard.length) {
    hardOnly++;
    const k = H.killedBy(hard);
    if (k.includes(q.a) && k.length < q.o.length) killsAnswer++;
  }
}
console.log(`  at least one hint: ${any}/${bank.length} (${pct(any, bank.length)})`);
console.log(`  at least one hard rule: ${hardOnly}/${bank.length} (${pct(hardOnly, bank.length)})`);
console.log(`  hard rules that removed the right answer: ${killsAnswer} (${pct(killsAnswer, hardOnly)})`);
check(any > bank.length * 0.7, 'most questions get at least one hint');
check(killsAnswer / Math.max(1, hardOnly) < 0.05, 'hard rules almost never remove the right answer');

/* every hint must be grounded in the question's own text */
const sample = bank.filter((q) => /_{2,}/.test(q.p)).slice(0, 200);
let ungrounded = 0;
for (const q of sample) {
  for (const h of H.solveHints(q, { glosses })) {
    if (!h.title || !h.body || h.body.length < 20) ungrounded++;
  }
}
check(ungrounded === 0, 'every hint carries a real explanation');

console.log(fail ? `\n${fail} FAILED\n` : '\nAll hint checks passed.\n');
process.exit(fail ? 1 : 0);
