'use strict';

/**
 * parse-guides.js — reads the course's worked-solution guides, one per exam
 * sitting, and turns the questions into the app's schema.
 *
 * Each guide walks a full 22-question English section. A question block opens
 * with a marker that carries BOTH the number and the key:
 *
 *     1( .3 )
 *
 * which reads, in the source's right-to-left layout, as "question 1, answer 3".
 * That is why these questions need no answer of mine: the course states them.
 *
 * Layout inside a block:
 *     מה קורא        the teacher's approach
 *     <English stem>
 *     (1) ... (4)    the options, each trailed by Hebrew commentary
 *     תרגום          a Hebrew translation
 *     מנה יומית      vocabulary hooks (harvested separately)
 *
 * Questions 1-8 are sentence completion and 9-12 restatement; both are taken.
 * Questions 13-22 belong to two reading passages, and THE PASSAGES ARE NOT IN
 * THE FILES — only the questions and the reasoning about them. A reading
 * question without its passage is unanswerable, so those are skipped rather
 * than shipped broken. Their explanations are still worth harvesting one day.
 */

const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, 'guides', 'text');
const OUT = path.join(__dirname, 'guide-questions.json');

const QMARK = /^\s*(\d{1,2})\(\s*\.(\d)\s*\)\s*$/;
/**
 * The option marker, tolerant of what the right-to-left layout does to it —
 * "(1) x", "(1 ) x", ")1( x" and "1) x" all occur — but NOT so tolerant that a
 * bare leading digit counts. A bracket is always required, because a stem can
 * wrap onto a line beginning with a number ("18th century.") and a marker that
 * accepted that read the stem's own tail as option 1.
 */
const OPTMARK = /^\s*(?:\(\s*([1-4])\s*\)|\)\s*([1-4])\s*\(|([1-4])\s*\))\s*[-–.]?\s*(.*)$/;

/** `{n, rest}` for a line that opens with an option marker, else null. */
function optMark(line) {
  const m = OPTMARK.exec(line);
  if (!m) return null;
  return { n: Number(m[1] || m[2] || m[3]), rest: m[4] };
}
const ANSWER_HEAD = /^\s*התשובות\s*$/;
/**
 * Page furniture. The underscore rule must be anchored at BOTH ends: a
 * sentence-completion stem can itself open with the blank ("_____ evidence to
 * the contrary, ..."), and an unanchored rule silently ate those questions.
 */
const NOISE = /^(={5} PAGE|\s*_{5,}\s*$|\s*$)/;
const SECTION_HEAD = /^\s*(השלמת משפטים|ניסוח מחדש|טקסט\s*\d)/;

const HEB = /[֐-׿]/;

/** How Latin a line is. Commentary is Hebrew; the question itself is English. */
function latinShare(s) {
  const t = s.replace(/\s/g, '');
  if (!t) return 0;
  let lat = 0, heb = 0;
  for (const ch of t) {
    if (/[A-Za-z]/.test(ch)) lat++;
    else if (HEB.test(ch)) heb++;
  }
  if (!lat && !heb) return 0;
  return lat / (lat + heb);
}
const isEnglish = (s) => latinShare(s) > 0.75 && /[A-Za-z]/.test(s);

/**
 * A line belonging to the stem. A completion stem can break across lines with
 * the blank alone on the second one ("______."), and that line holds no letters
 * at all, so testing it for being English ends the stem and loses the blank.
 */
const isStemLine = (s) => isEnglish(s) || (/_{3,}/.test(s) && !HEB.test(s));

const clean = (s) =>
  String(s || '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Strip the running header. Every page repeats the sitting's name, and the
 * extraction puts it on its own line above a rule of underscores.
 */
function stripNoise(lines, title) {
  return lines.filter((l) => {
    if (NOISE.test(l)) return false;
    const c = clean(l);
    if (!c) return false;
    if (title && c === clean(title)) return false;
    return true;
  });
}

function typeOf(n) {
  if (n >= 1 && n <= 8) return 'sentence_completion';
  if (n >= 9 && n <= 12) return 'restatement';
  return null; // 13-22: reading, whose passage the guide does not carry
}

/**
 * Pull one question out of its block.
 *
 * The stem is the English before the first option marker. The options each run
 * from their marker to the first Hebrew line after them, because the teacher
 * comments on every option in Hebrew directly beneath it.
 */
/** The English head of a mixed line: "vision – ראייה" yields "vision". */
function englishHead(s) {
  const t = clean(s);
  const cut = t.search(HEB);
  const head = clean(cut < 0 ? t : t.slice(0, cut)).replace(/[-–—:,.\s]+$/, '');
  return head;
}

/**
 * The stem is the FIRST run of English lines in the block. It must not be
 * gathered from the whole block, because the guide repeats the sentence again
 * under תרגום and that copy would be glued onto the end of the real one.
 */
function stemOf(lines, stopAt) {
  const parts = [];
  for (let i = 0; i < stopAt; i++) {
    const l = lines[i];
    if (/^\s*מה קורא/.test(l)) continue;
    if (isStemLine(l)) parts.push(clean(l));
    else if (parts.length) break;
  }
  return clean(parts.join(' '));
}

/**
 * Options listed inline under the stem, each trailed by Hebrew commentary.
 * This is the shape restatement questions always take, and most completions.
 */
function inlineOptions(lines, from) {
  const options = [];
  let expect = 1;
  for (let i = from; i < lines.length && options.length < 4; i++) {
    const m = optMark(lines[i]);
    if (!m || m.n !== expect || !isEnglish(m.rest)) continue;
    const parts = [clean(m.rest)];
    for (let j = i + 1; j < lines.length; j++) {
      if (optMark(lines[j]) || SECTION_HEAD.test(lines[j])) break;
      if (!isEnglish(lines[j])) break;
      parts.push(clean(lines[j]));
    }
    options.push(clean(parts.join(' ')));
    expect++;
  }
  return options;
}

/**
 * Some guides do not list the options under the stem at all — they appear only
 * further down under a "התשובות" heading, each with its Hebrew translation on
 * the same line. Those lines are mixed, so they are cut at the first Hebrew
 * character instead of being tested for being English.
 */
function answerBlockOptions(lines) {
  /* Usually the translated options sit under a "התשובות" heading, but some
     guides drop straight into them after "תרגום" with no heading at all. Start
     at whichever appears, and stop before the vocabulary hooks, whose lines are
     also numbered and would otherwise be read as options. */
  let from = lines.findIndex((l) => ANSWER_HEAD.test(l));
  if (from < 0) from = lines.findIndex((l) => /^\s*תרגום\s*$/.test(l));
  if (from < 0) from = 0;
  let to = lines.findIndex((l, i) => i > from && /^\s*מנה יומית/.test(l));
  if (to < 0) to = lines.length;

  const options = [];
  let expect = 1;
  for (let i = from + 1; i < to && options.length < 4; i++) {
    const text = optionText(lines[i], expect);
    if (text === null) continue;
    options.push(text);
    expect++;
  }
  return options;
}

/**
 * The English of a numbered option line, or null if this line is not option
 * `want`. The number usually leads, but the right-to-left layout can push it to
 * the end instead ("striking(4)"), so both placements are accepted.
 */
function optionText(line, want) {
  const lead = optMark(line);
  if (lead && lead.n === want) {
    const head = englishHead(lead.rest);
    if (head && /[A-Za-z]/.test(head)) return head;
  }
  const trail = /^\s*(.+?)\s*\(\s*([1-4])\s*\)\s*$/.exec(line);
  if (trail && Number(trail[2]) === want) {
    const head = englishHead(trail[1]);
    if (head && /[A-Za-z]/.test(head)) return head;
  }
  return null;
}

function parseBlock(num, answer, lines) {
  const type = typeOf(num);
  if (!type) return null;

  let firstOpt = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = optMark(lines[i]);
    if (m && m.n === 1 && isEnglish(m.rest)) { firstOpt = i; break; }
  }

  let options = firstOpt >= 0 ? inlineOptions(lines, firstOpt) : [];
  let stopAt = firstOpt >= 0 ? firstOpt : lines.length;
  if (options.length !== 4) {
    const fallback = answerBlockOptions(lines);
    if (fallback.length === 4) {
      options = fallback;
      if (firstOpt < 0) stopAt = lines.findIndex((l) => ANSWER_HEAD.test(l));
    }
  }
  if (options.length !== 4) return null;
  if (new Set(options.map((o) => o.toLowerCase())).size !== 4) return null;

  const stem = stemOf(lines, stopAt > 0 ? stopAt : lines.length);
  if (!stem || stem.length < 20) return null;

  const idx = answer - 1;
  if (idx < 0 || idx > 3) return null;

  return { number: num, type, prompt: stem, options, correctAnswerIndex: idx };
}

function parseGuide(text, name) {
  const title = (text.split('\n').find((l) => clean(l) && !NOISE.test(l)) || '').trim();
  const lines = stripNoise(text.split('\n'), title);

  // Where each question block starts.
  const heads = [];
  lines.forEach((l, i) => {
    const m = QMARK.exec(l);
    if (m) heads.push({ i, num: Number(m[1]), answer: Number(m[2]) });
  });

  const out = [];
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
    const q = parseBlock(h.num, h.answer, lines.slice(h.i + 1, end));
    if (q) out.push(Object.assign({ sitting: name }, q));
  });
  return { name, title: clean(title), markers: heads.length, questions: out };
}

function main() {
  const files = fs.readdirSync(RAW).filter((f) => f.endsWith('.txt')).sort();
  const all = [];
  let markers = 0, taken = 0;

  for (const f of files) {
    const g = parseGuide(fs.readFileSync(path.join(RAW, f), 'utf8'), f.replace(/\.txt$/, ''));
    markers += g.markers;
    const usable = g.questions.length;
    taken += usable;
    const sc = g.questions.filter((q) => q.type === 'sentence_completion').length;
    const rs = g.questions.filter((q) => q.type === 'restatement').length;
    console.log(
      `  ${g.name.padEnd(18)} ${String(g.markers).padStart(2)} marked · ` +
        `${String(sc).padStart(2)} completion + ${String(rs)} restatement = ${usable}`
    );
    for (const q of g.questions) {
      all.push(Object.assign({ id: `${g.name}:${q.number}`, source: 'course-guide', answerBy: 'course' }, q));
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(all, null, 2), 'utf8');
  console.log(
    `\n${files.length} guides · ${markers} answer markers · ${taken} questions taken ` +
      `(13-22 are reading, whose passages the guides do not carry)`
  );
}

if (require.main === module) main();

module.exports = { parseGuide, parseBlock, isEnglish, typeOf };
