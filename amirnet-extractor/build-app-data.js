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
