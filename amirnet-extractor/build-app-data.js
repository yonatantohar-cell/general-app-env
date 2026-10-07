'use strict';

/**
 * build-app-data.js — turns the extracted corpus into the app's data file.
 *
 *   node build-app-data.js
 *
 * The exam app ships `app/simulations.json` rather than the full export: it
 * needs the questions, not the provenance fields, and short keys keep the file
 * small enough to serve alongside the page.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, 'output', 'all-simulations.json');
const TARGET = path.join(__dirname, 'app', 'simulations.json');

if (!fs.existsSync(SOURCE)) {
  console.error(`Missing ${SOURCE}. Run the extractor first:\n  node index.js --from-url https://amirnetwords.com/tests`);
  process.exit(1);
}

const { simulations } = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));

const slim = simulations.map((simulation) => ({
  id: simulation.id,
  title: simulation.title,
  description: simulation.description,
  difficulty: simulation.difficulty,
  totalTimeSeconds: simulation.totalTimeSeconds,
  served: simulation.servedQuestionCount,
  sections: simulation.sections.map((section) => ({
    slot: section.slot,
    type: section.type,
    titleHe: section.titleHe,
    descHe: section.descriptionHe,
    time: section.timeLimitSeconds,
    serve: section.serveCount,
    passages: section.passages.map((passage) => ({ title: passage.title, text: passage.text })),
    questions: section.questions.map((question) => ({
      p: question.prompt,
      o: question.options.map((option) => option.text),
      a: question.correctAnswerIndex,
      e: question.explanation || '',
      d: question.difficulty || '',
      v: question.vocabulary || [],
    })),
  })),
}));

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, JSON.stringify(slim), 'utf8');

const questions = slim.reduce(
  (sum, s) => sum + s.sections.reduce((n, sec) => n + sec.questions.length, 0),
  0
);
console.log(
  `Wrote ${path.relative(process.cwd(), TARGET)} — ${slim.length} simulations, ` +
    `${questions} questions, ${(fs.statSync(TARGET).size / 1024).toFixed(0)}KB`
);

// ---------------------------------------------------------------------------
// Vocabulary list
// ---------------------------------------------------------------------------

/**
 * Two sources of vocabulary, merged:
 *
 *   1. the correct answer of every sentence-completion question — the word the
 *      examinee had to know to score the point;
 *   2. the `vocabulary` tags the site attaches to 480 of the 580 questions,
 *      which include the words that make a question hard even when they are
 *      not the answer (the distractors worth knowing, and words from the stem).
 *
 * The second source is the larger of the two and was previously unused. Each
 * entry records whether the word was ever a correct answer, so the list can be
 * read as "words to learn" with the highest-value ones marked.
 */
const VOCAB_TARGET = path.join(__dirname, 'app', 'vocabulary.json');

const vocab = new Map();

function note(word, { isAnswer, example }) {
  const key = String(word || '').toLowerCase().trim();
  if (!key || key.length > 40) return;
  if (!vocab.has(key)) vocab.set(key, { word: key, times: 0, answer: false, example: '' });
  const entry = vocab.get(key);
  entry.times += 1;
  if (isAnswer) entry.answer = true;
  // Prefer the sentence where the word was the answer: it shows the word doing
  // the work, which is the most useful context to learn it from.
  if (example && (!entry.example || (isAnswer && !entry.exampleIsAnswer))) {
    entry.example = example;
    entry.exampleIsAnswer = Boolean(isAnswer);
  }
}

for (const simulation of simulations) {
  for (const question of simulation.questions) {
    const stem = question.prompt || '';
    if (question.type === 'sentence_completion' && question.correctAnswerText) {
      note(question.correctAnswerText, { isAnswer: true, example: stem });
    }
    for (const word of question.vocabulary || []) {
      note(word, { isAnswer: false, example: stem });
    }
  }
}

const vocabList = [...vocab.values()]
  .map(({ exampleIsAnswer, ...rest }) => rest)
  .sort((a, b) => Number(b.answer) - Number(a.answer) || b.times - a.times || a.word.localeCompare(b.word));

fs.writeFileSync(VOCAB_TARGET, JSON.stringify(vocabList), 'utf8');
console.log(
  `Wrote ${path.relative(process.cwd(), VOCAB_TARGET)} — ${vocabList.length} words ` +
    `(${vocabList.filter((w) => w.answer).length} were a correct answer), ` +
    `${(fs.statSync(VOCAB_TARGET).size / 1024).toFixed(0)}KB`
);


// ---------------------------------------------------------------------------
// Trainer word pool
// ---------------------------------------------------------------------------

/**
 * The vocabulary trainer needs words worth drilling, which is neither "the most
 * frequent" nor "the rarest".
 *
 * Ranking by frequency alone returns so(32), because(25), but(14) — the words
 * the trainer should never ask about. But filtering by a frequency tier does
 * not fix it either: SCOWL puts `so`, `but` and `because` in the same tier as
 * `consistent`, `assumption`, `evidence` and `argument`, which ARE worth
 * drilling. Commonness is the wrong axis.
 *
 * The real split is grammatical: the junk is FUNCTION words — conjunctions,
 * prepositions, pronouns, determiners, auxiliaries — a closed class small
 * enough to list. Everything else is a content word and earns its place.
 */
const TRAINER_TARGET = path.join(__dirname, 'app', 'trainer-words.json');
const ACADEMIC_SRC = path.join(__dirname, 'vocab', 'academic-words.json');

const FUNCTION_WORDS = new Set(`
a an the this that these those such each every either neither both all any some no none
i me my mine myself you your yours yourself he him his she her hers it its they them their theirs
we us our ours who whom whose which what where when why how
am is are was were be been being have has had having do does did doing
can could shall should will would may might must ought need dare used
and or but nor for yet so because although though while whereas since unless until till
if whether than then thus hence therefore however moreover furthermore nevertheless nonetheless
otherwise meanwhile besides instead rather accordingly consequently
in on at by to from of off out up down over under above below across through into onto upon with
within without between among around about against during before after behind beyond beside
near toward towards along past per via amid despite
not very too quite just only even also still already yet always never often sometimes usually
more most less least much many few little more enough almost nearly rather somewhat
here there now today tonight tomorrow yesterday again once twice ever
as like unlike same other another else
`.trim().split(/\s+/));

/**
 * Junk for this trainer: a function word, or any multi-word entry. Every
 * multi-word item in the corpus is a connective phrase ("in order to",
 * "as a result", "owing to"), and the mnemonic method the trainer is built
 * around works on single words anyway.
 */
function isFunctional(term) {
  const t = term.toLowerCase().trim();
  if (/\s/.test(t)) return true;
  return FUNCTION_WORDS.has(t);
}

function buildTrainerPool() {
  const pool = new Map();

  // Source 1: the corpus vocabulary, which carries frequency and example sentences.
  for (const entry of JSON.parse(fs.readFileSync(VOCAB_TARGET, 'utf8'))) {
    if (entry.word.length < 4) continue;
    if (isFunctional(entry.word)) continue;
    pool.set(entry.word, {
      word: entry.word,
      times: entry.times || 1,
      answer: Boolean(entry.answer),
      example: entry.example || '',
      src: 'corpus',
    });
  }

  // Source 2: academic words harvested from the psychometric English sections.
  // Words only — no sentence, question or passage from those papers is used.
  if (fs.existsSync(ACADEMIC_SRC)) {
    for (const word of JSON.parse(fs.readFileSync(ACADEMIC_SRC, 'utf8'))) {
      if (isFunctional(word)) continue;
      const existing = pool.get(word);
      if (existing) existing.src = 'both';
      else pool.set(word, { word, times: 1, answer: false, example: '', src: 'academic' });
    }
  }

  // Most-repeated first: a word the corpus leans on is worth learning first.
  const list = [...pool.values()].sort(
    (a, b) => b.times - a.times || Number(b.answer) - Number(a.answer) || a.word.localeCompare(b.word)
  );

  fs.writeFileSync(TRAINER_TARGET, JSON.stringify(list), 'utf8');
  const bySrc = list.reduce((m, w) => ((m[w.src] = (m[w.src] || 0) + 1), m), {});
  console.log(
    `Wrote ${path.relative(process.cwd(), TRAINER_TARGET)} — ${list.length} words ` +
      `(${JSON.stringify(bySrc)}), ${(fs.statSync(TRAINER_TARGET).size / 1024).toFixed(0)}KB`
  );
}

buildTrainerPool();
