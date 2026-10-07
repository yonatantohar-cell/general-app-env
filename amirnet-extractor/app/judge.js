/*
 * judge.js — deciding whether a guess was right, without asking Claude.
 *
 * The trainer's loop is: a word is shown, you write what you think it means,
 * you are told whether you were right, and a memory hook gets built. The first
 * version needed `sample` for all of it, which means an account and a granted
 * permission — so for anyone who just opened the link, the whole loop was off.
 *
 * It does not need to be. 1,317 of the words in the pool arrive with the
 * Hebrew meaning the course itself wrote for them, and 794 with the hook the
 * course teaches. That is enough to run the loop locally: compare the guess
 * against the stored meaning, show the real one either way, and offer the
 * course's own hook instead of inventing one.
 *
 * WHAT THIS IS NOT. It compares Hebrew text; it does not understand it. A
 * learner who writes a correct synonym the course never listed will be marked
 * wrong. So the matcher is deliberately generous — a false "correct" costs a
 * repetition, a false "wrong" costs confidence — the real meaning is always
 * shown, and the page offers an explicit "I was right" correction that the
 * review schedule honours. judge.test.js measures both error directions across
 * every glossed word rather than asserting the matcher is good.
 *
 * Loaded in the browser as `Judge`, and required directly by the test.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Judge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FINALS = { 'ם': 'מ', 'ן': 'נ', 'ץ': 'צ', 'ף': 'פ', 'ך': 'כ' };
  /* One-letter words that attach to the front of a Hebrew word. Stripping one
     is always tried as an ALTERNATIVE reading, never as the only one, because
     plenty of real words simply start with these letters. */
  var PREFIX = 'והבלכמש';

  /** Niqqud off, final forms unified, punctuation gone, spaces collapsed. */
  function normalize(s) {
    return String(s || '')
      .replace(/[֑-ׇ]/g, '')
      .replace(/[םןץףך]/g, function (c) { return FINALS[c]; })
      .replace(/["'`״׳()[\]{}.!?־–—-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /** A meaning is written as a list: "לשמור, לחסוך, להציל". */
  function terms(s) {
    return normalize(s)
      .split(/[,;·|]| או /)
      .map(function (t) { return t.trim(); })
      .filter(function (t) { return t.length > 1; });
  }

  /** The readings of one term: itself, and itself without a leading particle. */
  function readings(t) {
    var out = [t];
    if (t.length >= 4 && PREFIX.indexOf(t.charAt(0)) >= 0) out.push(t.slice(1));
    return out;
  }

  /** Do these two terms name the same thing, as far as text can tell? */
  function termsMatch(a, b) {
    var A = readings(a), B = readings(b);
    for (var i = 0; i < A.length; i++) {
      for (var j = 0; j < B.length; j++) {
        var x = A[i], y = B[j];
        if (!x || !y) continue;
        if (x === y) return true;
        /* Containment only counts when the shorter side is a real word, not a
           two-letter fragment that would match half the dictionary. */
        var shorter = x.length <= y.length ? x : y;
        var longer = x.length <= y.length ? y : x;
        if (shorter.length >= 3 && longer.indexOf(shorter) >= 0) return true;
      }
    }
    return false;
  }

  /** The longest run of letters the two share, used only to spot "close". */
  function sharedRun(a, b) {
    var best = 0;
    for (var i = 0; i < a.length; i++) {
      for (var j = 0; j < b.length; j++) {
        var k = 0;
        while (i + k < a.length && j + k < b.length && a.charAt(i + k) === b.charAt(j + k)) k++;
        if (k > best) best = k;
      }
    }
    return best;
  }

  /**
   * @param guess   what the learner typed
   * @param meaning the stored Hebrew meaning
   * @returns {verdict: "correct"|"partial"|"wrong", matched: string|null}
   */
  function compare(guess, meaning) {
    var g = terms(guess), m = terms(meaning);
    if (!g.length || !m.length) return { verdict: 'wrong', matched: null };

    for (var i = 0; i < g.length; i++) {
      for (var j = 0; j < m.length; j++) {
        if (termsMatch(g[i], m[j])) return { verdict: 'correct', matched: m[j] };
      }
    }
    /* Not a match, but close enough that the learner was clearly in the right
       area — a shared stem of four letters or more. */
    for (var p = 0; p < g.length; p++) {
      for (var q = 0; q < m.length; q++) {
        if (sharedRun(g[p], m[q]) >= 4) return { verdict: 'partial', matched: m[q] };
      }
    }
    return { verdict: 'wrong', matched: null };
  }

  var DUNNO = ['', '-', '—', 'לא יודע', 'לא יודעת', 'אין לי מושג', '?', '??'];

  /**
   * The same shape the live judge produces, so the screen that shows it does
   * not care which one answered.
   *
   * @param word   the English word
   * @param guess  what the learner typed
   * @param entry  its trainer-pool entry: {he, seed:{hook}, example}
   */
  function judge(word, guess, entry) {
    var e = entry || {};
    var meaning = e.he || '';
    if (!meaning) return null;                 /* no stored meaning: cannot judge */

    var g = String(guess || '').trim();
    var gaveUp = DUNNO.indexOf(normalize(g)) >= 0;
    var r = gaveUp ? { verdict: 'wrong', matched: null } : compare(g, meaning);

    var note = gaveUp
      ? 'לא ניחשת, אז המילה תחזור מחר.'
      : r.verdict === 'correct'
        ? 'מה שכתבת מתאים ל"' + r.matched + '".'
        : r.verdict === 'partial'
          ? 'קרוב — אבל לא בדיוק. הפירוש שהקורס נותן הוא "' + meaning + '".'
          : 'הפירוש שהקורס נותן הוא "' + meaning + '".';

    var out = {
      verdict: r.verdict,
      meaning: meaning,
      english: e.example ? '' : '',
      note: note,
      mnemonic: '',
      story: '',
      by: 'local',
    };
    if (e.seed && e.seed.hook) {
      out.mnemonic = e.seed.hook;
      out.story = '';
    }
    return out;
  }

  /** Only words the local judge can actually handle. */
  function judgeable(entry) {
    return Boolean(entry && entry.he);
  }

  return {
    judge: judge, judgeable: judgeable, compare: compare,
    normalize: normalize, terms: terms, termsMatch: termsMatch, sharedRun: sharedRun,
  };
});
