'use strict';

/**
 * validate.js — sanity checks on the extracted output.
 *
 * The whole risk with scraping is silent partial success: a selector that
 * matches three questions out of twenty-five, or text that decoded wrong.
 * Both look like success unless something explicitly checks. This is that
 * something, and it exits non-zero so it cannot be ignored.
 *
 *   node validate.js [--expect 20]
 */

const fs = require('fs');
const path = require('path');

const JSON_DIR = path.join(__dirname, 'output', 'json');
const COMBINED = path.join(__dirname, 'output', 'all-simulations.json');

// Latin-1 mojibake signature: Hebrew read as single-byte Latin text.
const MOJIBAKE = /[ÃÂ×Ø][\u0080-¿†-›]|Ã[\u0090-¿]/;
const HEBREW = /[֐-׿]/;

function loadSimulations() {
  if (fs.existsSync(COMBINED)) {
    const parsed = JSON.parse(fs.readFileSync(COMBINED, 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.simulations || [];
  }
  if (!fs.existsSync(JSON_DIR)) return [];
  return fs
    .readdirSync(JSON_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((name) => JSON.parse(fs.readFileSync(path.join(JSON_DIR, name), 'utf8')));
}

function median(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function validate(simulations, expected) {
  const problems = [];
  const warnings = [];

  if (simulations.length === 0) {
    problems.push('No simulations found at all — nothing was extracted.');
    return { problems, warnings, rows: [] };
  }

  if (expected && simulations.length !== expected) {
    problems.push(
      `Expected ${expected} simulations but found ${simulations.length}. ` +
        'Either the site changed or discovery missed some pages — do not just accept this.'
    );
  }

  // Option counts across the whole corpus, to spot the odd malformed question.
  const allOptionCounts = [];
  for (const simulation of simulations) {
    for (const question of simulation.questions || []) {
      if (Array.isArray(question.options)) allOptionCounts.push(question.options.length);
    }
  }
  const typicalOptions = median(allOptionCounts);

  const rows = [];

  for (const simulation of simulations) {
    const id = simulation.id ?? '?';
    const questions = Array.isArray(simulation.questions) ? simulation.questions : [];

    if (questions.length === 0) {
      problems.push(`Simulation ${id} has 0 questions.`);
    }

    if (!simulation.title) warnings.push(`Simulation ${id} has no title.`);

    if (simulation.questionCount != null && simulation.questionCount !== questions.length) {
      problems.push(
        `Simulation ${id}: questionCount says ${simulation.questionCount} but ${questions.length} questions were parsed.`
      );
    }

    let emptyPrompts = 0;
    let missingOptions = 0;
    let withAnswers = 0;
    const promptLengths = [];

    for (const question of questions) {
      const prompt = String(question.prompt || '');
      const blob = JSON.stringify(question);

      if (!prompt.trim() && !question.passage) emptyPrompts += 1;
      promptLengths.push(prompt.length);

      if (/\[object Object\]/.test(blob)) {
        problems.push(`Simulation ${id} q${question.number}: "[object Object]" in the text.`);
      }
      if (/\bundefined\b|\bnull\b/.test(prompt)) {
        problems.push(`Simulation ${id} q${question.number}: literal "undefined"/"null" in the prompt.`);
      }
      if (MOJIBAKE.test(blob) && !HEBREW.test(blob)) {
        problems.push(
          `Simulation ${id} q${question.number}: text looks like broken encoding (mojibake), not Hebrew.`
        );
      }
      if (!Array.isArray(question.options) || question.options.length === 0) {
        missingOptions += 1;
      } else {
        if (typicalOptions && Math.abs(question.options.length - typicalOptions) > 1) {
          warnings.push(
            `Simulation ${id} q${question.number}: ${question.options.length} options (typical is ${typicalOptions}).`
          );
        }
        if (question.options.some((option) => !String(option.text || '').trim())) {
          problems.push(`Simulation ${id} q${question.number}: an answer option is empty.`);
        }
      }
      if (question.correctAnswer) withAnswers += 1;
    }

    if (emptyPrompts > 0) {
      problems.push(`Simulation ${id}: ${emptyPrompts} question(s) have no prompt text.`);
    }
    // All-or-nothing is fine (site may not publish answers); a mix means a parser gap.
    if (withAnswers > 0 && withAnswers < questions.length) {
      warnings.push(
        `Simulation ${id}: only ${withAnswers}/${questions.length} questions have a correct answer.`
      );
    }
    if (missingOptions > 0 && missingOptions < questions.length) {
      problems.push(
        `Simulation ${id}: ${missingOptions}/${questions.length} questions have no options while the rest do — likely a parser gap.`
      );
    }

    rows.push({
      id,
      title: (simulation.title || '').slice(0, 34),
      questions: questions.length,
      medianOptions: typicalOptions,
      medianPromptLen: median(promptLengths),
      answers: withAnswers,
    });
  }

  return { problems, warnings, rows };
}

function main() {
  const expectIndex = process.argv.indexOf('--expect');
  const expected = expectIndex !== -1 ? Number(process.argv[expectIndex + 1]) : null;

  const simulations = loadSimulations();
  const { problems, warnings, rows } = validate(simulations, expected);

  console.log('\nExtraction report\n');
  console.log('  #   questions  opts  promptLen  answers  title');
  console.log('  --  ---------  ----  ---------  -------  -----');
  for (const row of rows) {
    console.log(
      `  ${String(row.id).padStart(2)}  ${String(row.questions).padStart(9)}  ` +
        `${String(row.medianOptions).padStart(4)}  ${String(row.medianPromptLen).padStart(9)}  ` +
        `${String(row.answers).padStart(7)}  ${row.title}`
    );
  }

  const totalQuestions = rows.reduce((sum, row) => sum + row.questions, 0);
  console.log(`\n  ${rows.length} simulations, ${totalQuestions} questions total`);

  if (warnings.length) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const warning of warnings.slice(0, 20)) console.log(`  ! ${warning}`);
    if (warnings.length > 20) console.log(`  … and ${warnings.length - 20} more`);
  }

  if (problems.length) {
    console.log(`\nFAILED (${problems.length} problem(s)):`);
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    console.log('');
    process.exit(1);
  }

  console.log('\nAll checks passed.\n');
}

if (require.main === module) main();

module.exports = { validate, loadSimulations };
