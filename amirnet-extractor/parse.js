'use strict';

/**
 * parse.js — HTML -> simulation objects.
 *
 * ⚠ CALIBRATION POINT. This is the only file whose correctness depends on the
 * site's actual markup, which was not reachable when it was written (the
 * domain is blocked by this environment's egress policy). It therefore
 * implements three GENERAL strategies, tries them in order of reliability, and
 * reports which one fired so it can be tightened against the real HTML with a
 * small edit rather than a rewrite.
 *
 * Run `node inspect.js <url>` first — it says which strategy should win.
 */

const cheerio = require('cheerio');

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E'];

const clean = (text) =>
  String(text == null ? '' : text)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Guess the question type from its wording. */
function inferType(prompt, hasPassage) {
  const text = String(prompt || '').toLowerCase();
  if (hasPassage) return 'reading-comprehension';
  if (/\b(restate|closest in meaning|best expresses)\b/.test(text)) return 'restatement';
  if (/_{2,}|\.\.\.\./.test(text)) return 'sentence-completion';
  if (/\bmeans\b|\bdefinition\b|\bsynonym\b/.test(text)) return 'vocabulary';
  return undefined;
}

function finalizeQuestion(question, index) {
  const result = {
    number: question.number || index + 1,
    prompt: clean(question.prompt),
  };
  const type = question.type || inferType(result.prompt, Boolean(question.passage));
  if (type) result.type = type;
  if (question.passage) result.passage = clean(question.passage);
  if (question.options && question.options.length) {
    result.options = question.options
      .map((option, optionIndex) => ({
        label: option.label || OPTION_LABELS[optionIndex] || String(optionIndex + 1),
        text: clean(option.text),
      }))
      .filter((option) => option.text);
  }
  // Only include these when the page actually provided them — never invent one.
  if (question.correctAnswer) result.correctAnswer = clean(question.correctAnswer);
  if (question.explanation) result.explanation = clean(question.explanation);
  return result;
}

// ---------------------------------------------------------------------------
// Strategy 1 — radio inputs (most reliable when present)
// ---------------------------------------------------------------------------

/**
 * Radio buttons in an HTML quiz are grouped by `name`: one group per question,
 * one radio per option. That grouping is structural rather than cosmetic, so it
 * survives CSS changes that would break class-based selectors.
 */
function viaRadioInputs($) {
  const groups = new Map();

  $('input[type=radio]').each((_, element) => {
    const name = $(element).attr('name');
    if (!name) return;
    if (!groups.has(name)) groups.set(name, []);

    const $input = $(element);
    // The option's text: its <label>, else its parent's text.
    const id = $input.attr('id');
    let text = id ? clean($(`label[for="${id}"]`).text()) : '';
    if (!text) text = clean($input.closest('label').text());
    if (!text) text = clean($input.parent().text());

    groups.get(name).push({ label: clean($input.attr('value')) || '', text });
  });

  if (groups.size === 0) return null;

  const questions = [];
  let index = 0;
  for (const [name, options] of groups) {
    // Question text = nearest preceding block element with real text.
    const $first = $(`input[type=radio][name="${name}"]`).first();
    let prompt = '';
    let $cursor = $first.parent();
    for (let hops = 0; hops < 6 && !prompt; hops += 1) {
      const candidate = clean($cursor.clone().find('input,label,li').remove().end().text());
      if (candidate.length > 10) prompt = candidate;
      $cursor = $cursor.parent();
      if (!$cursor || $cursor.length === 0) break;
    }
    questions.push(finalizeQuestion({ number: index + 1, prompt, options }, index));
    index += 1;
  }

  return { questions, strategy: 'radio-inputs' };
}

// ---------------------------------------------------------------------------
// Strategy 2 — repeated quiz containers
// ---------------------------------------------------------------------------

function viaContainers($) {
  const selectors = [
    '.question',
    '.quiz-question',
    '[class*="question"]',
    '[class*="Question"]',
    'li.question',
    '.test-question',
  ];

  for (const selector of selectors) {
    const $blocks = $(selector);
    if ($blocks.length < 2) continue;

    const questions = [];
    $blocks.each((index, element) => {
      const $block = $(element);
      const $options = $block.find('li, label, .option, [class*="option"], [class*="answer"]');
      const options = $options
        .toArray()
        .map((option) => ({ text: clean($(option).text()) }))
        .filter((option) => option.text);

      const prompt = clean($block.clone().find($options.toArray()).remove().end().text());
      if (prompt || options.length) {
        questions.push(finalizeQuestion({ number: index + 1, prompt, options }, index));
      }
    });

    if (questions.length >= 2) return { questions, strategy: `containers(${selector})` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Strategy 3 — plain-text numbering (last resort)
// ---------------------------------------------------------------------------

/**
 * Fallback for pages that are essentially formatted text:
 *   1. The committee decided to ___ the meeting.
 *   (A) postpone  (B) propose  (C) promote  (D) proclaim
 */
function viaTextPattern($) {
  const text = $('body')
    .text()
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ');

  const blocks = text.split(/\n\s*(?=\d{1,2}[.)]\s)/).filter((block) => /^\s*\d{1,2}[.)]\s/.test(block));
  if (blocks.length < 2) return null;

  const questions = blocks.map((block, index) => {
    const number = Number(/^\s*(\d{1,2})[.)]/.exec(block)[1]);
    const optionRegex = /\(?([A-Ea-e1-5])\)[.\s]\s*([^\n(]{1,300}?)(?=\s*\(?[A-Ea-e1-5]\)[.\s]|\n|$)/g;

    const options = [];
    let match;
    while ((match = optionRegex.exec(block)) !== null) {
      options.push({ label: match[1].toUpperCase(), text: match[2] });
    }

    const firstOptionAt = options.length ? block.indexOf(`(${options[0].label}`) : -1;
    const prompt = (firstOptionAt > 0 ? block.slice(0, firstOptionAt) : block).replace(/^\s*\d{1,2}[.)]\s*/, '');

    return finalizeQuestion({ number, prompt, options }, index);
  });

  return { questions, strategy: 'text-pattern' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse one simulation page.
 * @returns {{simulation: object, strategy: string|null}}
 */
function parseSimulation(html, meta = {}) {
  const $ = cheerio.load(html);

  const title =
    clean(meta.title) ||
    clean($('h1').first().text()) ||
    clean($('title').first().text()) ||
    '';

  const attempt = viaRadioInputs($) || viaContainers($) || viaTextPattern($) || { questions: [], strategy: null };

  const simulation = {
    id: meta.id,
    title,
    url: meta.url,
    questionCount: attempt.questions.length,
    extractedAt: new Date().toISOString(),
    questions: attempt.questions,
  };

  return { simulation, strategy: attempt.strategy };
}

/**
 * Find the simulation pages linked from the index page.
 * @returns {Array<{id:number, title:string, url:string}>}
 */
function parseSimulationList(html, baseUrl) {
  const $ = cheerio.load(html);
  const found = new Map();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;

    let absolute;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      return;
    }

    // Same host only, and the path should look like a test/simulation page.
    if (new URL(absolute).host !== new URL(baseUrl).host) return;
    if (!/(test|sim|quiz|exam|practice)/i.test(absolute) && !/\d/.test(absolute)) return;
    if (absolute.replace(/\/$/, '') === baseUrl.replace(/\/$/, '')) return;

    const text = clean($(element).text());
    if (!found.has(absolute)) found.set(absolute, text);
  });

  return [...found.entries()].map(([url, title], index) => ({ id: index + 1, title, url }));
}

module.exports = {
  parseSimulation,
  parseSimulationList,
  viaRadioInputs,
  viaContainers,
  viaTextPattern,
  inferType,
  clean,
};
