'use strict';

/**
 * parse-vocab.js — harvests word / meaning / hook triples from the older guides.
 *
 * The guides from the early sittings are laid out differently from the later
 * ones: they never print the English question at all, only a Hebrew summary of
 * it, and then the four options spelled out like a glossary —
 *
 *     1- Lodge -  לגור, להתאכסן. אולי הם פולנים והם גרים בלודז
 *     2- Fade - לדהות, לדעוך. כמו סיום של שיר, שהכל נמוג
 *     3- Dismiss - לפטור, לשחרר. כמו שמפקד משחרר חייל
 *
 * That makes them useless as exam questions (parse-guides.js rejects a stem it
 * cannot show) but better than the newer files for vocabulary, because each
 * line carries BOTH the Hebrew meaning and the hook, separated by the first
 * full stop. The newer guides give the meaning in one block and the hook in
 * another; parse-hooks.js takes those.
 *
 * Every option of every question is harvested, not only the correct one: a
 * distractor is a real word the course chose to teach beside it.
 */

const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, 'guides', 'text');
const OUT = path.join(__dirname, 'guide-vocab.json');

const HEB = /[֐-׿]/;
const NOISE = /^(={5} PAGE|\s*_{5,}\s*$|\s*$)/;

/**
 * A glossed option. Two layouts, both "number, English word, dash, Hebrew":
 *
 *   1- Lodge -  לגור, להתאכסן. אולי הם פולנים...     the old glossary files
 *   1) vision – ראייה                                 the "התשובות" list everywhere else
 *
 * The second is by far the larger source, and it is where the Hebrew meanings
 * come from — no other file in the set states what a word means.
 */
const GLOSS = /^\s*[()]?\s*([1-4])\s*[-–—)]\s*([A-Za-z][A-Za-z'\- ]{1,28}?)\s*[-–—]\s*(.+)$/;

const clean = (s) =>
  String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Split the Hebrew tail into the meaning and the hook. The meaning is the short
 * gloss before the first full stop; whatever follows is the picture the teacher
 * draws. Many lines carry only a meaning, and those are kept with no hook.
 */
function splitGloss(tail) {
  const t = clean(tail);
  /* The meaning ends at the first full stop OR the first bracket: the teacher
     writes "בולט (כמו מראה שמכה בכם)" and the bracket is already the picture,
     not part of what the word means. */
  const stops = ['.', '('].map((c) => t.indexOf(c)).filter((i) => i > 0);
  if (!stops.length) return { meaning: t, hook: '' };
  const cut = Math.min(...stops);
  return { meaning: clean(t.slice(0, cut)), hook: clean(t.slice(cut).replace(/^[.\s]+/, '')) };
}

function vocabIn(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    if (NOISE.test(raw)) continue;
    const m = GLOSS.exec(raw);
    if (!m) continue;
    const word = clean(m[2]).toLowerCase();
    if (!/^[a-z][a-z'\- ]*$/.test(word)) continue;
    const { meaning, hook } = splitGloss(m[3]);
    /* The meaning must OPEN in Hebrew. Merely containing Hebrew is not enough:
       a hyphenated headword splits wrongly ("anti" + "inflammatory drugs- תרופות")
       and that leaves English at the front of what claims to be the meaning. */
    if (!HEB.test(meaning.charAt(0))) continue;
    if (meaning.length < 2) continue;
    out.push({ word, meaning, hook });
  }
  return out;
}

/** Real English words only — the same SCOWL gate the hook harvest uses. */
function realWords() {
  let tiers;
  try {
    tiers = require('wordlist-english');
  } catch {
    console.error('  wordlist-english is not installed; headwords are not filtered');
    return null;
  }
  const all = new Set();
  for (const k of Object.keys(tiers)) {
    if (!/^english\//.test(k)) continue;
    for (const w of tiers[k]) all.add(String(w).toLowerCase());
  }
  return all;
}

function main() {
  const files = fs.readdirSync(RAW).filter((f) => f.endsWith('.txt')).sort();
  const dict = realWords();
  const best = new Map();
  let seen = 0, rejected = 0;

  for (const f of files) {
    const name = f.replace(/\.txt$/, '');
    for (const v of vocabIn(fs.readFileSync(path.join(RAW, f), 'utf8'))) {
      seen += 1;
      if (dict && !dict.has(v.word)) { rejected += 1; continue; }
      const prev = best.get(v.word);
      /* Prefer the telling that carries a hook, then the fuller one. */
      const better =
        !prev ||
        (v.hook && !prev.hook) ||
        (Boolean(v.hook) === Boolean(prev.hook) &&
          v.meaning.length + v.hook.length > prev.meaning.length + prev.hook.length);
      if (better) best.set(v.word, { ...v, sitting: name });
    }
  }

  const out = [...best.values()].sort((a, b) => a.word.localeCompare(b.word));
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');
  const withHook = out.filter((v) => v.hook).length;
  console.log(
    `${files.length} guides · ${seen} glossed options · ${out.length} distinct words ` +
      `(${withHook} with a hook, ${rejected} rejected as non-words) ` +
      `-> ${path.relative(process.cwd(), OUT)}`
  );
}

if (require.main === module) main();

module.exports = { vocabIn, splitGloss };
