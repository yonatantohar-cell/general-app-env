'use strict';

/**
 * parse-course.js — reads the "מנה יומית" drill sheets from the course the user
 * bought and turns them into the app's question schema.
 *
 * Sheet shape: a Hebrew mnemonic title, then numbered sentence-completion
 * items, each with four options. Numbering is inconsistent in the source —
 * "1.0", "2. 0" and a bare "6." all occur — and the stray "0" leaks into the
 * stem when the number is split across the extraction, so both are handled.
 *
 * The sheets carry no answer key. Answers are supplied in answers.json, which
 * records who decided each one, because an answer this app scores against
 * should never be silently assumed.
 */

const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, 'text');
const OUT = path.join(__dirname, 'course-questions.json');
const ANSWERS = path.join(__dirname, 'answers.json');

const clean = (s) =>
  String(s || '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Strip the numbering debris. The sheets write items as "3.0" and then repeat a
 * bare "0" marker, so the extracted stem can start with TWO zeros, not one.
 */
function cleanStem(stem) {
  return clean(stem).replace(/^(?:0\s*)+/, '');
}

/**
 * Normalise the blank. The underscores sometimes arrive split ("_ _"), and a
 * greedy run would also swallow the space that follows the blank, gluing it to
 * the next word ("______is EFSMI").
 */
function normaliseBlank(stem) {
  return stem.replace(/_\s+_/g, '__').replace(/_{2,}/g, '______');
}

function parseSheet(text, file) {
  const title = (() => {
    const m = /מנה יומית\s*\n\s*([^\n]+?)\s*\n\s*\d{1,2}\s*\.\s*0?/.exec(text);
    return m ? clean(m[1]) : '';
  })();

  const items = [];
  // "N." optionally followed by the stray 0, then the stem up to the first option.
  const re = /(\d{1,2})\s*\.\s*(.+?)(?=\(1\))/gs;
  let m;
  while ((m = re.exec(text)) !== null) {
    const number = Number(m[1]);
    const stem = normaliseBlank(cleanStem(m[2]));
    if (!stem || stem.length < 15) continue;

    const after = text.slice(m.index + m[0].length);
    const opts = [];
    const optRe = /\((\d)\)\s*([A-Za-z][A-Za-z\- ']*)/g;
    let o;
    while ((o = optRe.exec(after.slice(0, 500))) !== null && opts.length < 4) {
      opts.push(clean(o[2]));
    }
    if (opts.length !== 4) continue;
    if (items.some((it) => it.number === number)) continue;
    items.push({ number, stem, options: opts });
  }

  items.sort((a, b) => a.number - b.number);
  return { file, title, items };
}

function main() {
  const sheets = fs
    .readdirSync(RAW)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((f) => parseSheet(fs.readFileSync(path.join(RAW, f), 'utf8'), f.replace(/\.txt$/, '')));

  const answers = fs.existsSync(ANSWERS) ? JSON.parse(fs.readFileSync(ANSWERS, 'utf8')) : {};

  let total = 0;
  let answered = 0;
  const questions = [];

  for (const sheet of sheets) {
    for (const item of sheet.items) {
      total += 1;
      const key = `${sheet.file}:${item.number}`;
      const rec = answers[key];
      const q = {
        id: key,
        source: 'course',
        sheet: sheet.file,
        mnemonicTitle: sheet.title,
        type: 'sentence_completion',
        prompt: item.stem,
        options: item.options,
      };
      if (rec && typeof rec.answer === 'number') {
        q.correctAnswerIndex = rec.answer;
        q.answerBy = rec.by || 'claude';
        if (rec.note) q.note = rec.note;
        answered += 1;
      }
      questions.push(q);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(questions, null, 2), 'utf8');
  console.log(
    `Parsed ${sheets.length} sheets, ${total} questions, ${answered} with an answer ` +
      `(${total - answered} still unanswered)`
  );
  for (const s of sheets) console.log(`  ${s.file}: ${s.items.length} questions · "${s.title}"`);
}

if (require.main === module) main();

module.exports = { parseSheet, cleanStem, normaliseBlank };
