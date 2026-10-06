'use strict';

/**
 * render.js — simulation object -> readable Markdown.
 *
 * Depends only on the schema, never on the site's HTML, so it is unaffected by
 * whatever the parser ends up looking like.
 *
 * Layout choice: questions first, answer key at the END. That way the file is
 * actually usable for practice — answers next to the questions would spoil it.
 */

/** Escape the few characters that would break Markdown structure. */
function escapeMd(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/([*_`[\]])/g, '\\$1')
    .trim();
}

/** Multi-line text as a blockquote (used for reading passages). */
function blockquote(text) {
  return String(text)
    .trim()
    .split('\n')
    .map((line) => `> ${line.trim()}`)
    .join('\n');
}

const TYPE_LABELS = {
  'sentence-completion': 'השלמת משפטים',
  restatement: 'ניסוח מחדש',
  'reading-comprehension': 'הבנת הנקרא',
  vocabulary: 'אוצר מילים',
};

function renderQuestion(question, index) {
  const number = question.number || index + 1;
  const parts = [];

  const typeLabel = question.type ? TYPE_LABELS[question.type] || question.type : null;
  parts.push(`### ${number}.${typeLabel ? `  *(${typeLabel})*` : ''}`);

  if (question.passage) {
    parts.push('');
    parts.push(blockquote(question.passage));
  }

  if (question.prompt) {
    parts.push('');
    parts.push(escapeMd(question.prompt));
  }

  if (Array.isArray(question.options) && question.options.length > 0) {
    parts.push('');
    const options = question.options;
    options.forEach((option, optionIndex) => {
      const label = option.label ? `**${option.label}.** ` : '- ';
      // Two trailing spaces = hard line break. Without them Markdown collapses
      // consecutive option lines into one run-together paragraph.
      const isLast = optionIndex === options.length - 1;
      parts.push(`${label}${escapeMd(option.text)}${isLast ? '' : '  '}`);
    });
  }

  return parts.join('\n');
}

/**
 * @param {object} simulation
 * @returns {string} Markdown document
 */
function renderSimulation(simulation) {
  const lines = [];

  lines.push(`# ${escapeMd(simulation.title || `סימולציה ${simulation.id}`)}`);
  lines.push('');

  const meta = [];
  if (simulation.questionCount != null) meta.push(`**שאלות:** ${simulation.questionCount}`);
  if (simulation.url) meta.push(`**מקור:** ${simulation.url}`);
  if (simulation.extractedAt) meta.push(`**חולץ:** ${simulation.extractedAt}`);
  if (meta.length) {
    lines.push(meta.join('  \n'));
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  const questions = Array.isArray(simulation.questions) ? simulation.questions : [];
  questions.forEach((question, index) => {
    lines.push(renderQuestion(question, index));
    lines.push('');
  });

  // Answer key — only if answers were actually found on the page.
  const answered = questions.filter((q) => q.correctAnswer);
  if (answered.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## מפתח תשובות');
    lines.push('');
    lines.push('| שאלה | תשובה |');
    lines.push('|---|---|');
    for (const question of answered) {
      lines.push(`| ${question.number} | ${escapeMd(question.correctAnswer)} |`);
    }
    lines.push('');

    const explained = answered.filter((q) => q.explanation);
    if (explained.length > 0) {
      lines.push('### הסברים');
      lines.push('');
      for (const question of explained) {
        lines.push(`**${question.number}.** ${escapeMd(question.explanation)}`);
        lines.push('');
      }
    }
  } else if (questions.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('*לא נמצאו תשובות נכונות בדף המקור — הסימולציה חולצה ללא מפתח תשובות.*');
    lines.push('');
  }

  return lines.join('\n');
}

/** Index file listing every simulation. */
function renderIndex(simulations) {
  const lines = [];
  lines.push('# סימולציות amirnetwords');
  lines.push('');
  lines.push(`סך הכל **${simulations.length}** סימולציות.`);
  lines.push('');
  lines.push('| # | שם | שאלות | קובץ |');
  lines.push('|---|---|---|---|');
  for (const simulation of simulations) {
    const file = `simulation-${String(simulation.id).padStart(2, '0')}.md`;
    lines.push(
      `| ${simulation.id} | ${escapeMd(simulation.title || '')} | ${simulation.questionCount ?? '?'} | [${file}](./${file}) |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { renderSimulation, renderIndex, escapeMd, blockquote };
