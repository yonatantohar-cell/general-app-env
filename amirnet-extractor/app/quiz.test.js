/* Lifts the vocabulary quiz builder and the SM-2 scheduler out of exam.html and
   runs them against the words actually studied in the app (fixtures/cards.json).
   The point is the distractor guard: the fixture carries the real confusable
   pairs, so a regression there fails here rather than on screen.

   node quiz.test.js */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'exam.html'), 'utf8');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cards.json'), 'utf8'));

function lift(from, to) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('could not lift ' + from);
  return html.slice(a, b);
}

/* Two separate regions: the scheduler lives with the trainer, the quiz below it. */
const src =
  lift('/* ---------- scheduling: SM-2', '/* ---------- picking the next word') +
  lift('var Q={items:[]', '/* ---------- screens ----------') +
  lift('function shuffled(arr)', '/* A reading section\'s level');

const api = new Function(
  'cards', 'COURSE', 'shuffled',
  src + '\n;return {schedule, newCard, quizPool, related, glossClash, glossTerms, buildItem, buildQuiz,' +
        ' completionFor, buildCompletionQuiz};'
);

let fail = 0;
const check = (c, m) => {
  if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m);
};

/* The cards as the app holds them: keyed by word, each with a meaning. */
const cards = {};
for (const c of FIX.cards) {
  cards[c.word] = {
    word: c.word,
    meaning: c.meaning,
    mnemonic: c.noMnemonic ? '' : 'סימן לבדיקה עבור ' + c.word,
    ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0,
  };
}
/* buildCompletionQuiz reads the course bank and shuffled() comes from the exam
   engine, so both are handed in rather than lifted a second time. */
const COURSE = require('./course-bank.json');
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const q = api(cards, COURSE, shuffle);
const pool = q.quizPool();

console.log('=== pool ===');
check(pool.length === 38, 'every studied word with a meaning is in the pool (' + pool.length + ')');
check(
  q.quizPool.call(null) !== undefined,
  'quizPool returns a list'
);

/* ---------------------------------------------------------------- the guard */
console.log('\n=== same-root pairs the guard must reject ===');
[
  ['careful', 'carefully'],
  ['assumption', 'assumptions'],
  ['consistent', 'inconsistent'],
  ['distinguish', 'distinguished'],
  ['precedent', 'preceding'],
].forEach(([a, b]) => check(q.related(a, b) && q.related(b, a), a + ' / ' + b + ' (both directions)'));

console.log('\n=== unrelated pairs the guard must NOT reject ===');
[
  ['claims', 'clear'],
  ['save', 'support'],
  ['study', 'subverts'],
  ['dense', 'distinguish'],
  ['range', 'reduce'],
  ['economy', 'evidence'],
].forEach(([a, b]) => check(!q.related(a, b), a + ' / ' + b));

console.log('\n=== overlapping meanings the guard must reject ===');
check(
  q.glossClash('סותר, עומד בסתירה', 'לא עקבי, סותר'),
  'contradict vs inconsistent — both glossed "סותר"'
);
check(q.glossClash('עקבי, יציב', 'לא עקבי, סותר'), 'עקבי inside לא עקבי');
check(q.glossClash('זהיר, נזהר', 'בזהירות'), 'זהיר inside בזהירות');
check(!q.glossClash('כלכלה', 'תקדים'), 'unrelated meanings do not clash');
check(!q.glossClash('מושך', 'רגיש'), 'short unrelated meanings do not clash');
check(q.glossTerms('סותר, עומד בסתירה').length === 2, 'a comma-separated meaning splits into terms');

/* ------------------------------------------------- every generated question */
console.log('\n=== sweep: every question from every word, both directions ===');
let twoAnswers = 0, dupOption = 0, badIndex = 0, shortOpts = 0, leaks = 0;
const seen = {};
for (const dir of ['en2he', 'he2en']) {
  for (const card of pool) {
    const it = q.buildItem(card, pool, dir);
    seen[it.options.length] = (seen[it.options.length] || 0) + 1;

    if (it.a < 0 || it.a >= it.options.length) badIndex++;
    if (new Set(it.options).size !== it.options.length) dupOption++;
    if (it.options.length < 4) shortOpts++;

    /* Any option other than the keyed one that is defensible = a broken item. */
    const right = it.options[it.a];
    for (let i = 0; i < it.options.length; i++) {
      if (i === it.a) continue;
      const other = it.options[i];
      const clash = dir === 'en2he' ? q.glossClash(right, other) : q.related(right, other);
      if (clash) {
        twoAnswers++;
        if (twoAnswers <= 5) console.log('    two answers: ' + card.word + ' [' + dir + '] ' + right + ' <> ' + other);
      }
    }
    /* The prompt must never appear among the options. */
    if (it.options.indexOf(it.prompt) >= 0) leaks++;
  }
}
console.log('  option counts: ' + JSON.stringify(seen));
check(badIndex === 0, 'the answer index is always in range');
check(dupOption === 0, 'no question repeats an option');
check(twoAnswers === 0, 'no question has a second defensible answer');
check(leaks === 0, 'the prompt never appears among its own options');
check(shortOpts === 0, 'all 38 words can be served with a full four options');

/* --------------------------------------------------------- a thin pool copes */
console.log('\n=== a pool too thin for four options ===');
const thin = ['economy', 'precedent', 'rigorous'].map((w) => cards[w]);
const thinItems = q.buildQuiz(thin, 0);
check(thinItems.length === 3, 'a three-word pool still builds a three-question quiz');
check(
  thinItems.every((it) => it.options.length === 3 && it.a >= 0 && it.a < 3),
  'each question is served with the three options that exist, honestly short'
);
const pair = q.buildQuiz([cards.economy, cards.enter], 0);
check(
  pair.every((it) => it.options.length === 2),
  'a two-word pool degrades to two options rather than failing'
);

/* ------------------------------------------------------------ quiz assembly */
console.log('\n=== quiz assembly ===');
const ten = q.buildQuiz(pool, 10);
check(ten.length === 10, 'a 10-word quiz has 10 questions');
check(new Set(ten.map((i) => i.word)).size === 10, 'no word appears twice in one sitting');
const dirs = ten.filter((i) => i.dir === 'en2he').length;
check(dirs === 5, 'the directions are evenly split (' + dirs + ' of 10 are en2he)');
const all = q.buildQuiz(pool, 0);
check(all.length === 38, 'size 0 means every studied word');
const a1 = q.buildQuiz(pool, 10).map((i) => i.word).join(',');
const a2 = q.buildQuiz(pool, 10).map((i) => i.word).join(',');
check(a1 !== a2, 'two sittings are not the same ten words');
check(
  ten.every((it) => (it.dir === 'en2he' ? it.prompt === it.word : it.prompt === cards[it.word].meaning)),
  'the prompt matches the direction'
);
check(
  ten.every((it) => (it.dir === 'en2he'
    ? it.options[it.a] === cards[it.word].meaning
    : it.options[it.a] === it.word)),
  'the keyed option is the right one for the direction'
);
check(cards.save.mnemonic === '' && q.buildItem(cards.save, pool, 'en2he').hook === '',
  'a word saved without a hook yields no hint');

/* ------------------------------------------------------------------- SM-2 */
console.log('\n=== scheduling ===');
const DAY = 86400000;
let c = q.newCard('x');
c = q.schedule(c, true);
const i1 = c.interval;
c = q.schedule(c, true);
const i2 = c.interval;
c = q.schedule(c, true);
check(i1 === 1 && i2 > i1 && c.interval > i2, 'a correct streak pushes the interval out (' + [i1, i2, c.interval].join(' → ') + ')');
check(c.ease > 2.5, 'free recall raises ease (' + c.ease.toFixed(2) + ')');

/* Recognition: the interval still grows, the ease does not. */
let r = q.newCard('y');
r = q.schedule(r, true, true);
r = q.schedule(r, true, true);
const easeAfter = r.ease;
check(r.interval > 1, 'recognition still pushes the interval out (' + r.interval + ')');
check(easeAfter === 2.5, 'recognition leaves ease alone (' + easeAfter + ')');

let w = q.schedule({ word: 'z', ease: 2.5, interval: 40, reps: 9, lapses: 0, due: 0 }, false, true);
check(w.interval === 1, 'a miss comes back tomorrow');
check(w.lapses === 1, 'a miss counts as a lapse');
check(w.ease < 2.5, 'a miss lowers ease (' + w.ease.toFixed(2) + ')');
check(Math.abs(w.due - (Date.now() + DAY)) < 5000, 'due is set one day out');

let floor = { word: 'f', ease: 1.3, interval: 1, reps: 1, lapses: 9, due: 0 };
for (let i = 0; i < 5; i++) floor = q.schedule(floor, false);
check(floor.ease >= 1.3, 'ease never falls through its floor (' + floor.ease.toFixed(2) + ')');

/* ------------------------------------ completion on the words already learned */
console.log('\n=== sentence completion on learned words ===');
const learnedWords = pool.map((c) => c.word);
const avail = q.completionFor(learnedWords);
check(avail.length > 0, `${avail.length} course questions turn on a word in the studied set`);
check(avail.every((x) => x.t !== 'restatement'), 'restatement is never served as a completion drill');
check(avail.every((x) => learnedWords.includes(x.v[0])),
  'every served question keys on a studied word, not merely mentions one');
check(avail.every((x) => /_{3,}/.test(x.p)), 'every served stem carries its blank');

const unknown = q.completionFor(['zzzznotaword']);
check(unknown.length === 0, 'a word never studied yields nothing');

const drill = q.buildCompletionQuiz(pool, 5);
check(drill.length === Math.min(5, avail.length), `a 5-question drill is built (${drill.length})`);
check(drill.every((it) => it.dir === 'completion'), 'items are tagged as completion');
check(drill.every((it) => it.options.length === 4 && it.a >= 0 && it.a < 4), 'four options with a key in range');
check(drill.every((it) => it.options[it.a].toLowerCase() === it.word), 'the keyed option is the learned word');
check(drill.every((it) => it.hook === (cards[it.word] || {}).mnemonic || !cards[it.word]),
  'each item carries the learner\'s own hook as its hint');

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nAll quiz checks passed.\n');
process.exit(fail ? 1 : 0);
