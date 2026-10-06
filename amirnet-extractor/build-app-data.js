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
