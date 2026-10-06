'use strict';

/**
 * render.js — simulation object -> readable Markdown.
 *
 * Mirrors the exam's own structure (six sections, each with its own time
 * limit), because that is how the material is meant to be worked through.
 * Questions come first and the answer key last, so the file stays usable for
 * practice rather than spoiling itself.
 */

function escapeMd(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/([*_`[\]])/g, '\\$1')
    .trim();
}

function blockquote(text) {
  return String(text)
    .trim()
    .split('\n')
    .map((line) => `> ${line.trim()}`)
    .join('\n');
}

const TYPE_HE = {
  sentence_completion: 'השלמת משפטים',
  reading_comprehension: 'הבנת הנקרא',
  restatement: 'ניסוח מחדש',
};

const DIFFICULTY_HE = { easy: 'קל', medium: 'בינוני', hard: 'קשה', advanced: 'מתקדם' };

function minutes(seconds) {
  if (!Number.isFinite(seconds)) return '';
  return `${Math.round(seconds / 60)} דקות`;
}

function renderQuestion(question) {
  const parts = [];
  parts.push(`#### ${question.number}.`);
  parts.push('');
  parts.push(escapeMd(question.prompt));

  if (Array.isArray(question.options) && question.options.length) {
    parts.push('');
    question.options.forEach((option, index) => {
      const isLast = index === question.options.length - 1;
      // Two trailing spaces force a hard break; without them Markdown merges
      // the options into one paragraph.
      parts.push(`**${option.label}.** ${escapeMd(option.text)}${isLast ? '' : '  '}`);
    });
  }

  return parts.join('\n');
}

function renderSection(section) {
  const lines = [];
  const title = section.titleHe || TYPE_HE[section.type] || section.type;

  const meta = [];
  if (section.serveCount) meta.push(`${section.serveCount} שאלות בסימולציה`);
  if (section.questions) meta.push(`${section.questions.length} במאגר`);
  if (section.timeLimitSeconds) meta.push(minutes(section.timeLimitSeconds));

  lines.push(`## פרק ${section.slot} — ${escapeMd(title)}`);
  lines.push('');
  if (meta.length) {
    lines.push(`*${meta.join(' · ')}*`);
    lines.push('');
  }
  if (section.descriptionHe) {
    lines.push(escapeMd(section.descriptionHe));
    lines.push('');
  }

  for (const passage of section.passages || []) {
    lines.push(`### קטע הקריאה: ${escapeMd(passage.title)}`);
    lines.push('');
    lines.push(blockquote(passage.text));
    lines.push('');
  }

  for (const question of section.questions || []) {
    lines.push(renderQuestion(question));
    lines.push('');
  }

  return lines.join('\n');
}

function renderAnswerKey(questions) {
  const answered = questions.filter((question) => question.correctAnswer);
  if (answered.length === 0) {
    return '*לא נמצאו תשובות נכונות בדף המקור.*\n';
  }

  const lines = [];
  lines.push('## מפתח תשובות');
  lines.push('');
  lines.push('| שאלה | תשובה | הניסוח הנכון |');
  lines.push('|---|---|---|');
  for (const question of answered) {
    lines.push(
      `| ${question.number} | ${question.correctAnswer} | ${escapeMd(question.correctAnswerText || '')} |`
    );
  }
  lines.push('');

  const explained = answered.filter((question) => question.explanation);
  if (explained.length) {
    lines.push('## הסברים');
    lines.push('');
    for (const question of explained) {
      lines.push(`**${question.number}.** ${escapeMd(question.explanation)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderSimulation(simulation) {
  const lines = [];

  lines.push(`# ${escapeMd(simulation.title || `סימולציה ${simulation.id}`)}`);
  lines.push('');

  if (simulation.description) {
    lines.push(escapeMd(simulation.description));
    lines.push('');
  }

  const meta = [];
  if (simulation.difficulty) meta.push(`**רמה:** ${DIFFICULTY_HE[simulation.difficulty] || simulation.difficulty}`);
  if (simulation.questionCount != null) meta.push(`**שאלות במאגר:** ${simulation.questionCount}`);
  if (simulation.servedQuestionCount) meta.push(`**מוגשות בסימולציה:** ${simulation.servedQuestionCount}`);
  if (simulation.totalTimeSeconds) meta.push(`**זמן:** ${minutes(simulation.totalTimeSeconds)}`);
  if (simulation.url) meta.push(`**מקור:** ${simulation.url}`);
  if (meta.length) {
    lines.push(meta.join('  \n'));
    lines.push('');
  }

  // The pool is deliberately larger than one sitting; say so rather than let
  // the mismatch look like a mistake.
  if (simulation.servedQuestionCount && simulation.questionCount > simulation.servedQuestionCount) {
    lines.push(
      `> הסימולציה מגישה ${simulation.servedQuestionCount} שאלות מתוך מאגר של ${simulation.questionCount}, ` +
        'ובוחרת אותן באופן מסתגל. כאן מופיע המאגר המלא.'
    );
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  if (Array.isArray(simulation.sections) && simulation.sections.length) {
    for (const section of simulation.sections) {
      lines.push(renderSection(section));
    }
  } else {
    for (const question of simulation.questions || []) {
      lines.push(renderQuestion(question));
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(renderAnswerKey(simulation.questions || []));

  return lines.join('\n');
}

function renderIndex(simulations) {
  const lines = [];
  lines.push('# סימולציות אמירנט — amirnetwords');
  lines.push('');
  const totalQuestions = simulations.reduce((sum, s) => sum + (s.questions || []).length, 0);
  lines.push(`**${simulations.length}** סימולציות · **${totalQuestions}** שאלות בסך הכול.`);
  lines.push('');
  lines.push('| # | סימולציה | רמה | שאלות | קובץ |');
  lines.push('|---|---|---|---|---|');
  for (const simulation of simulations) {
    const file = `simulation-${String(simulation.id).padStart(2, '0')}.md`;
    lines.push(
      `| ${simulation.id} | ${escapeMd(simulation.title || '')} | ${DIFFICULTY_HE[simulation.difficulty] || simulation.difficulty || ''} | ${simulation.questionCount ?? '?'} | [${file}](./${file}) |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { renderSimulation, renderIndex, escapeMd, blockquote };
