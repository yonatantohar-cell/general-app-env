'use strict';

/**
 * parse-hooks.js — harvests the vocabulary hooks the guides teach.
 *
 * Every worked question ends with a "מנה יומית" block in which the teacher
 * gives the memory hook for the words that question turned on. The hooks are
 * phonetic bridges into Hebrew, the same device the trainer uses, so they feed
 * it directly instead of being invented at runtime:
 *
 *     evidence  - ראיות כשהראיות במשפט זיכו אותו, הוא הביא ריקוד (אבי-דאנס)
 *     convicted - מורשע ... זה חיבור של המילה con יחד, עם, והמילה vicious
 *
 * The block runs to the end of its question, so the hook text is everything
 * from the headword until the next headword or the block's end. Lines are
 * right-to-left prose with English words embedded, which is why a headword is
 * recognised by its shape — a lone English word at the start of a line,
 * followed by a dash — rather than by parsing the sentence.
 */

const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, 'guides', 'text');
const OUT = path.join(__dirname, 'guide-hooks.json');

const BLOCK_HEAD = /^\s*מנה יומית\s*$/;
const QMARK = /^\s*\d{1,2}\(\s*\.\d\s*\)\s*$/;
const NOISE = /^(={5} PAGE|\s*_{5,}\s*$|\s*$)/;
const HEB = /[֐-׿]/;

/** "evidence - ראיות ..." or "strip – להסיר" → the headword. */
const HEADWORD = /^\s*([A-Za-z][A-Za-z'-]{2,})\s*[-–—]\s*(.*)$/;

const clean = (s) =>
  String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

function hooksIn(text) {
  const lines = text.split('\n').filter((l) => !NOISE.test(l));
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    if (!BLOCK_HEAD.test(lines[i])) continue;

    // The block ends at the next question, or at the next block.
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (QMARK.test(lines[j]) || BLOCK_HEAD.test(lines[j])) { end = j; break; }
    }

    let cur = null;
    for (let j = i + 1; j < end; j++) {
      const m = HEADWORD.exec(lines[j]);
      if (m) {
        if (cur) found.push(cur);
        cur = { word: m[1].toLowerCase(), parts: [clean(m[2])] };
      } else if (cur) {
        cur.parts.push(clean(lines[j]));
      }
    }
    if (cur) found.push(cur);
    i = end - 1;
  }

  return found
    .map((h) => ({ word: h.word, hook: clean(h.parts.join(' ')) }))
    .filter((h) => h.hook.length >= 12 && HEB.test(h.hook));
}

/**
 * A real English headword. The teacher also writes Latin roots and Hebrew
 * transliterations into these blocks ("spect", "retro-spect", "mit-pa"), and
 * those look exactly like headwords on the page. SCOWL settles it: eight such
 * fragments are rejected and every genuine word survives.
 */
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
  /* One word can be taught in several sittings. Keep the fullest telling —
     the longest one is the one that actually explains the picture. */
  const best = new Map();
  let seen = 0;
  let rejected = 0;

  for (const f of files) {
    const name = f.replace(/\.txt$/, '');
    for (const h of hooksIn(fs.readFileSync(path.join(RAW, f), 'utf8'))) {
      seen += 1;
      if (dict && !dict.has(h.word)) { rejected += 1; continue; }
      const prev = best.get(h.word);
      if (!prev || h.hook.length > prev.hook.length) {
        best.set(h.word, { word: h.word, hook: h.hook, sitting: name });
      }
    }
  }

  const out = [...best.values()].sort((a, b) => a.word.localeCompare(b.word));
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');
  console.log(
    `${files.length} guides · ${seen} hooks taught · ${out.length} distinct words ` +
      (rejected ? `(${rejected} rejected as root fragments, not words) ` : '') +
      `-> ${path.relative(process.cwd(), OUT)}`
  );
}

if (require.main === module) main();

module.exports = { hooksIn };
