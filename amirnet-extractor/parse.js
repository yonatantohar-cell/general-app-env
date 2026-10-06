'use strict';

/**
 * parse.js — page -> simulation object.
 *
 * Primary path is the Next.js Flight payload (see flight.js): the site renders
 * client-side, so the HTML holds no questions, but the payload holds the full
 * record including correct answers and Hebrew explanations.
 *
 * The HTML heuristics below are kept as a fallback in case the site stops
 * shipping the payload. They are not used today — the run log says which path
 * produced each simulation.
 */

const cheerio = require('cheerio');

const { extractFlightPayload, extractObjectAfterKey } = require('./flight.js');

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

const clean = (text) =>
  String(text == null ? '' : text)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const SECTION_TYPE_HE = {
  sentence_completion: 'השלמת משפטים',
  reading_comprehension: 'הבנת הנקרא',
  restatement: 'ניסוח מחדש',
};

/** index 3 -> "D". Returns '' when the source gives no answer. */
function indexToLabel(index) {
  if (!Number.isInteger(index) || index < 0) return '';
  return OPTION_LABELS[index] || String(index + 1);
}

/**
 * Map one raw question to our schema.
 * Fields absent from the source are omitted rather than invented.
 */
function mapQuestion(raw, context) {
  const options = Array.isArray(raw.options)
    ? raw.options.map((text, index) => ({ label: OPTION_LABELS[index] || String(index + 1), text: clean(text) }))
    : [];

  const question = {
    number: context.number,
    sourceId: raw.id,
    section: context.sectionSlot,
    sectionType: raw.type || context.sectionType,
    type: raw.type || context.sectionType,
    prompt: clean(raw.prompt || raw.sentence || raw.question),
    options,
  };

  if (context.passage) {
    question.passageTitle = clean(context.passage.title);
    question.passage = clean(context.passage.text);
  }

  const label = indexToLabel(raw.correctAnswerIndex);
  if (label) {
    question.correctAnswer = label;
    question.correctAnswerIndex = raw.correctAnswerIndex;
    question.correctAnswerText = options[raw.correctAnswerIndex]
      ? options[raw.correctAnswerIndex].text
      : undefined;
  }

  if (raw.explanation) question.explanation = clean(raw.explanation);
  if (raw.difficulty) question.difficulty = raw.difficulty;
  if (Array.isArray(raw.vocabulary) && raw.vocabulary.length) question.vocabulary = raw.vocabulary;
  if (Array.isArray(raw.skills) && raw.skills.length) question.skills = raw.skills;

  return question;
}

/**
 * Build a simulation from the site's own `test` object.
 *
 * Note on counts: each section holds a POOL of questions and serves a subset
 * (`serveCount`) adaptively, so the pool is larger than the 23 questions any
 * one sitting presents. We extract the whole pool — that is more content, not
 * less — and record both numbers so the difference is visible rather than
 * looking like a bug.
 */
function fromTestObject(test, meta) {
  const sections = [];
  const flat = [];
  let number = 0;

  for (const rawSection of test.sections || []) {
    const passages = Array.isArray(rawSection.passages) ? rawSection.passages : [];
    const passageById = new Map(passages.map((passage) => [passage.id, passage]));

    const questions = (rawSection.questions || []).map((raw) => {
      number += 1;
      const passage = raw.passageId ? passageById.get(raw.passageId) : passages[0];
      const mapped = mapQuestion(raw, {
        number,
        sectionSlot: rawSection.slot,
        sectionType: rawSection.type,
        passage: rawSection.type === 'reading_comprehension' ? passage : undefined,
      });
      flat.push(mapped);
      return mapped;
    });

    sections.push({
      slot: rawSection.slot,
      type: rawSection.type,
      titleHe: clean(rawSection.titleHe) || SECTION_TYPE_HE[rawSection.type] || '',
      titleEn: clean(rawSection.titleEn),
      descriptionHe: clean(rawSection.descriptionHe),
      timeLimitSeconds: rawSection.timeLimitSeconds,
      serveCount: rawSection.serveCount,
      adaptive: Boolean(rawSection.adaptive),
      passages: passages.map((passage) => ({
        title: clean(passage.title),
        topic: passage.topic,
        text: clean(passage.text),
      })),
      questions,
    });
  }

  return {
    id: meta.id,
    slug: test.id,
    title: clean(test.title),
    description: clean(test.description),
    difficulty: test.difficultyBand,
    url: meta.url,
    totalTimeSeconds: test.totalTimeSeconds,
    servedQuestionCount: test.servedQuestionCount,
    questionCount: flat.length,
    extractedAt: new Date().toISOString(),
    sections,
    questions: flat,
  };
}

// ---------------------------------------------------------------------------
// Fallback HTML heuristics (unused while the Flight payload is present)
// ---------------------------------------------------------------------------

function viaRadioInputs($) {
  const groups = new Map();
  $('input[type=radio]').each((_, element) => {
    const name = $(element).attr('name');
    if (!name) return;
    if (!groups.has(name)) groups.set(name, []);
    const $input = $(element);
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
    const $first = $(`input[type=radio][name="${name}"]`).first();
    let prompt = '';
    let $cursor = $first.parent();
    for (let hops = 0; hops < 6 && !prompt; hops += 1) {
      const candidate = clean($cursor.clone().find('input,label,li').remove().end().text());
      if (candidate.length > 10) prompt = candidate;
      $cursor = $cursor.parent();
      if (!$cursor || $cursor.length === 0) break;
    }
    index += 1;
    questions.push({
      number: index,
      prompt,
      options: options.map((option, i) => ({ label: option.label || OPTION_LABELS[i], text: option.text })),
    });
  }
  return { questions, strategy: 'radio-inputs' };
}

function viaContainers($) {
  for (const selector of ['.question', '.quiz-question', '[class*="question"]']) {
    const $blocks = $(selector);
    if ($blocks.length < 2) continue;
    const questions = [];
    $blocks.each((index, element) => {
      const $block = $(element);
      const $options = $block.find('li, label, .option, [class*="option"]');
      const options = $options
        .toArray()
        .map((option, i) => ({ label: OPTION_LABELS[i], text: clean($(option).text()) }))
        .filter((option) => option.text);
      const prompt = clean($block.clone().find($options.toArray()).remove().end().text());
      if (prompt || options.length) questions.push({ number: index + 1, prompt, options });
    });
    if (questions.length >= 2) return { questions, strategy: `containers(${selector})` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @returns {{simulation: object|null, strategy: string|null}}
 */
function parseSimulation(html, meta = {}) {
  const payload = extractFlightPayload(html);
  const test = payload ? extractObjectAfterKey(payload, '"test":') : null;

  if (test && Array.isArray(test.sections) && test.sections.length > 0) {
    return { simulation: fromTestObject(test, meta), strategy: 'next-flight-payload' };
  }

  // Fallbacks — only reached if the site changes how it ships data.
  const $ = cheerio.load(html);
  const attempt = viaRadioInputs($) || viaContainers($);
  if (!attempt) return { simulation: null, strategy: null };

  return {
    simulation: {
      id: meta.id,
      title: clean($('h1').first().text()) || clean($('title').first().text()),
      url: meta.url,
      questionCount: attempt.questions.length,
      extractedAt: new Date().toISOString(),
      questions: attempt.questions,
    },
    strategy: attempt.strategy,
  };
}

/**
 * Find the simulation pages linked from the index.
 *
 * `/tests/test-NN` is only a description page; the questions live at
 * `/tests/test-NN/play`, so the discovered links are mapped there.
 */
function parseSimulationList(html, baseUrl) {
  const $ = cheerio.load(html);
  const found = new Map();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const match = /^\/tests\/(test-\d+)(?:\/play)?\/?$/.exec(href.split('?')[0]);
    if (!match) return;
    const slug = match[1];
    if (!found.has(slug)) {
      found.set(slug, new URL(`/tests/${slug}/play`, baseUrl).toString());
    }
  });

  return [...found.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))
    .map(([slug, url], index) => ({ id: index + 1, slug, title: '', url }));
}

module.exports = { parseSimulation, parseSimulationList, fromTestObject, clean, indexToLabel };
