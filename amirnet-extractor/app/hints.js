/*
 * hints.js — what could have told you the answer.
 *
 * Every hint this produces points at something actually in the question: the
 * connective that reverses the sentence, the preposition that fixes the part of
 * speech, the two options that mean the same thing in Hebrew and therefore
 * cannot both be right. Nothing here is generic advice; a rule that finds no
 * evidence in a given question stays silent for it.
 *
 * Each hint carries `hard`. A hard rule holds by the grammar of the language —
 * break it and the sentence is not English. A soft rule is a tendency of the
 * people who write these exams, and hints.test.js measures every one of them
 * against the whole bank rather than taking the claim on trust.
 *
 * Loaded in the browser as `Hints`, and required directly by the test.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Hints = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BLANK = /_{2,}/;

  /* ---------------------------------------------------------------- words */

  function words(s) {
    return String(s || '')
      .replace(/_{2,}/g, ' \u0000 ')            // the blank, as its own token
      .split(/[^A-Za-z'\u0000-]+/)
      .filter(Boolean);
  }

  /* `to` is deliberately absent: it is both a preposition ("to the store") and
     the infinitive marker ("to run"), and the two demand opposite things. */
  var PREPS = ('in on at of for with about from by into through over under '
    + 'between among during against without within upon toward towards across')
    .split(' ');
  var DETS = ('a an the his her their its this that these those my our your '
    + 'no any some each every').split(' ');
  var MODALS = 'can could shall should will would may might must'.split(' ');
  var BE = 'is are was were be been being am'.split(' ');

  /* ------------------------------------------------------- part of speech */
  /*
   * Guessed from the ending, which is the same morphology the learner is being
   * taught to read. It returns a SET of possibilities, because English endings
   * are ambiguous ("assistant" is a noun, "distant" an adjective) and a guess
   * that pretends to be certain would eliminate correct answers.
   */
  function posOf(w) {
    var t = String(w || '').toLowerCase().trim();
    var out = {};
    if (!t) return out;

    /* Unambiguous endings first. These are the only ones allowed to rule an
       option OUT, because a wrong elimination costs the learner the answer. */
    if (/(tion|sion|ment|ness|ity|ance|ence|ship|hood|ism|ist|ure|age|cy)$/.test(t)) out.noun = 1;
    if (/(ous|ful|less|ible|able|ish)$/.test(t)) out.adjective = 1;

    /* Ambiguous endings. `fugitive` and `captive` are nouns, `native` is both,
       `animal` is a noun and `legal` an adjective — measured on the bank,
       treating any of these as decisive was what made the rule unreliable. */
    if (/(ive|al|ant|ent|ate|ic|ary)$/.test(t)) { out.noun = 1; out.adjective = 1; }
    if (/ly$/.test(t)) { out.adverb = 1; out.adjective = 1; }
    if (/ing$/.test(t)) { out.gerund = 1; out.noun = 1; out.adjective = 1; }
    if (/ed$/.test(t)) { out.past = 1; out.adjective = 1; }
    if (/ee$/.test(t)) out.noun = 1;
    return out;
  }

  /** Could this word fill a slot that needs `need`? Unknown counts as yes. */
  function canBe(w, need) {
    var p = posOf(w);
    var known = Object.keys(p).length;
    if (!known) return true;
    if (need === 'noun') return Boolean(p.noun || p.gerund);
    if (need === 'adjective') return Boolean(p.adjective || p.past || p.gerund);
    if (need === 'adverb') return Boolean(p.adverb);
    if (need === 'base-verb') return !(p.noun || p.adjective || p.adverb) || Boolean(p.past);
    return true;
  }

  /* ------------------------------------------------------------- the slot */
  /*
   * What the blank's neighbours demand of it. Only the cases that are actually
   * decidable from one neighbouring word are reported.
   */
  function slot(stem) {
    var ws = words(stem);
    var i = ws.indexOf('\u0000');
    if (i < 0) return null;
    var before = (ws[i - 1] || '').toLowerCase();
    var after = (ws[i + 1] || '').toLowerCase();

    if (MODALS.indexOf(before) >= 0)
      return { need: 'base-verb', cue: before, where: 'before',
               why: 'אחרי פועל מודאלי בא פועל בצורת המקור, בלי שום תוספת' };
    if (PREPS.indexOf(before) >= 0)
      return { need: 'noun', cue: before, where: 'before',
               why: 'אחרי מילת יחס בא שם עצם, או פועל בתוספת ing שמתפקד כשם עצם' };
    if (DETS.indexOf(before) >= 0) {
      /* "the ___ of the water" — the blank IS the noun, not a word describing
         one. Measured on the bank, reading every determiner as calling for an
         adjective was wrong often enough to make the whole rule worthless. */
      if (!after || PREPS.indexOf(after) >= 0 || after === 'to' || BE.indexOf(after) >= 0)
        return { need: 'noun', cue: before, where: 'before',
                 why: 'אחרי מילית היידוע ולפני מילת יחס, החסר הוא שם העצם עצמו' };
      if (DETS.indexOf(after) < 0)
        return { need: 'adjective', cue: before, where: 'before',
                 why: 'בין מילית היידוע לשם העצם בא שם תואר' };
      return null;
    }
    if (BE.indexOf(before) >= 0)
      return { need: 'adjective', cue: before, where: 'before',
               why: 'אחרי פועל "to be" בא שם תואר, או צורת הסביל של פועל' };
    return null;
  }

  /* -------------------------------------------------------- the operators */

  var REVERSE = [
    ['although', 'למרות ש'], ['even though', 'למרות ש'], ['though', 'אף ש'],
    ['however', 'אולם'], ['nevertheless', 'אף על פי כן'], ['nonetheless', 'למרות זאת'],
    ['despite', 'למרות'], ['in spite of', 'על אף'], ['unlike', 'בשונה מ'],
    ['whereas', 'ואילו'], ['while', 'בעוד ש'], ['in contrast', 'לעומת זאת'],
    ['on the contrary', 'נהפוך הוא'], ['unless', 'אלא אם'], ['yet', 'ועדיין'],
    ['rather than', 'במקום'], ['instead of', 'במקום'], ['but', 'אבל'],
  ];
  var CONTINUE = [
    ['because', 'מכיוון ש'], ['since', 'מכיוון ש'], ['due to', 'עקב'],
    ['owing to', 'בגלל'], ['on account of', 'בגלל'], ['therefore', 'לכן'],
    ['thus', 'לפיכך'], ['hence', 'מכאן ש'], ['consequently', 'כתוצאה מכך'],
    ['as a result', 'כתוצאה מכך'], ['moreover', 'יתרה מכך'], ['furthermore', 'בנוסף'],
    ['in addition', 'בנוסף'], ['similarly', 'בדומה לכך'], ['likewise', 'כמו כן'],
    ['indeed', 'אכן'], ['in fact', 'למעשה'], ['so that', 'כדי ש'],
  ];

  function findIn(stem, table) {
    var low = ' ' + String(stem || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
    var hits = [];
    for (var k = 0; k < table.length; k++) {
      if (low.indexOf(' ' + table[k][0] + ' ') >= 0) hits.push(table[k]);
    }
    /* Longest first: "even though" should report itself, not "though". */
    return hits.sort(function (a, b) { return b[0].length - a[0].length; });
  }

  function connective(stem) {
    var r = findIn(stem, REVERSE);
    var c = findIn(stem, CONTINUE);
    if (!r.length && !c.length) return null;
    /* Both kinds present: report the one that appears first, since that is the
       gate the reader meets before reaching the blank. */
    var low = String(stem).toLowerCase();
    var pick = null, dir = null;
    if (r.length) { pick = r[0]; dir = 'reverse'; }
    if (c.length) {
      if (!pick || low.indexOf(c[0][0]) < low.indexOf(pick[0])) { pick = c[0]; dir = 'continue'; }
    }
    return { word: pick[0], he: pick[1], dir: dir };
  }

  /* ------------------------------------------------------------- prefixes */

  var PREFIX = [
    [/^(un|in|im|il|ir)(?=[a-z]{4})/, 'שלילה', '-'],
    [/^(dis|mis|mal)(?=[a-z]{3})/, 'רע, שגוי או מופרד', '-'],
    [/^(de|sub|under)(?=[a-z]{4})/, 'הפחתה או ירידה', '-'],
    [/^(co|com|con|col)(?=[a-z]{4})/, 'יחד, במשותף', '+'],
    [/^(bene|bon)(?=[a-z]{2})/, 'טוב', '+'],
    [/^(pre|pro)(?=[a-z]{4})/, 'לפני, קדימה, בעד', '+'],
  ];
  /* Words that merely begin with those letters. Without this list the rule
     calls `understand`, `important` and `delight` negative, which is exactly
     the trap the learner was warned about. */
  var NOT_A_PREFIX = ('understand understanding important impression important interest '
    + 'international interior delight deliver deliberate design desire determine develop '
    + 'depend derive describe decide declare demand democracy debate decade degree delicate '
    + 'preference present pressure precious predict prefer prepare press pretty prevent '
    + 'promise property proportion propose protect prove provide process produce product '
    + 'profession professor profile profit program progress project promote prompt '
    + 'company compare complete complex computer common communicate community compete '
    + 'condition conduct conference confidence confirm conflict connect consider consist '
    + 'constant construct contain content context continue contract control convince '
    + 'college colour column collect contribute convert conclusion conclude concert '
    + 'subject substance success').split(' ');

  function prefixOf(w) {
    var t = String(w || '').toLowerCase();
    if (NOT_A_PREFIX.indexOf(t) >= 0) return null;
    for (var i = 0; i < PREFIX.length; i++) {
      var m = PREFIX[i][0].exec(t);
      if (m) return { prefix: m[1], meaning: PREFIX[i][1], polarity: PREFIX[i][2] };
    }
    return null;
  }

  /* ------------------------------------------------- synonyms and look-alikes */

  function glossTerms(meaning) {
    return String(meaning || '').split(/[,;·|]/)
      .map(function (t) { return t.replace(/\s+/g, ' ').trim(); })
      .filter(function (t) { return t.length > 1; });
  }

  /** Two Hebrew glosses that share a term describe the same thing. */
  function sameMeaning(m1, m2) {
    var A = glossTerms(m1), B = glossTerms(m2);
    for (var i = 0; i < A.length; i++) {
      for (var j = 0; j < B.length; j++) {
        if (A[i] === B[j]) return A[i];
        if (A[i].length >= 4 && B[j].indexOf(A[i]) >= 0) return A[i];
        if (B[j].length >= 4 && A[i].indexOf(B[j]) >= 0) return B[j];
      }
    }
    return null;
  }

  /**
   * Options that mean the same thing. In a question with one right answer they
   * cannot both be it, so both go. This reads the Hebrew glosses the course
   * itself wrote, not a guess at what the words mean.
   */
  function synonymPairs(options, glosses) {
    if (!glosses) return [];
    var out = [];
    for (var i = 0; i < options.length; i++) {
      for (var j = i + 1; j < options.length; j++) {
        var a = glosses[String(options[i]).toLowerCase()];
        var b = glosses[String(options[j]).toLowerCase()];
        if (!a || !b) continue;
        /* fraction / fracture are both "שבר" in Hebrew and neither is a synonym
           of the other. A shared gloss between two words that LOOK alike is a
           translation collision, not synonymy, so those pairs are not reported.
           This was found by measurement: without it the rule fired once on the
           whole bank and was wrong that once. */
        if (lookAlike(options[i], options[j])) continue;
        var shared = sameMeaning(a, b);
        if (shared) out.push({ i: i, j: j, shared: shared, he: [a, b] });
      }
    }
    return out;
  }

  /** Does `a` look or sound like `b`? Containment, or a long shared opening. */
  function lookAlike(a, b) {
    a = String(a).toLowerCase(); b = String(b).toLowerCase();
    if (a.length < 5 || b.length < 5) return false;
    if (a === b) return false;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
    var n = Math.min(a.length, b.length), i = 0;
    while (i < n && a.charAt(i) === b.charAt(i)) i++;
    return i >= 5;
  }

  /** An option built to catch the eye of someone skimming the sentence. */
  function soundAlikes(stem, options) {
    var ws = words(stem).filter(function (w) { return w.length >= 5; });
    var out = [];
    options.forEach(function (o, i) {
      for (var k = 0; k < ws.length; k++) {
        if (lookAlike(o, ws[k])) { out.push({ i: i, option: o, like: ws[k] }); return; }
      }
    });
    return out;
  }

  /* ------------------------------------------------------- other signals */

  var EXTREME = ('always never completely absolutely entirely totally all none '
    + 'every no one everyone nothing everything utterly wholly').split(' ');

  function extremes(options) {
    var out = [];
    options.forEach(function (o, i) {
      var ws = String(o).toLowerCase().split(/[^a-z]+/).filter(Boolean);
      for (var k = 0; k < ws.length; k++) {
        if (EXTREME.indexOf(ws[k]) >= 0) { out.push({ i: i, word: ws[k] }); return; }
      }
    });
    return out;
  }

  /**
   * A definition planted beside the blank. The writers avoid demanding a word
   * nobody could know, so a hard word is often explained in plain language
   * right after a comma, colon, semicolon or dash.
   */
  function definitionAnchor(stem) {
    var s = String(stem || '');
    var at = s.search(BLANK);
    if (at < 0) return null;
    var tail = s.slice(at);
    var m = /_{2,}\s*([,:;—–-])\s*(.{10,})/.exec(tail);
    if (m) return { punct: m[1], text: m[2].trim().slice(0, 90), where: 'after' };
    var head = s.slice(0, at);
    var m2 = /([,:;—–-])\s*([^,:;]{10,})\s*$/.exec(head);
    if (m2) return { punct: m2[1], text: m2[2].trim().slice(0, 90), where: 'before' };
    return null;
  }

  /* ------------------------------------------------------------- assembly */

  /**
   * @param q       {p, o, a}      the question as the app stores it
   * @param opts    {glosses}      word -> Hebrew meaning, for the synonym rule
   * @returns [{id, hard, title, body, kills:[option indexes]}]
   */
  function solveHints(q, opts) {
    var stem = q.p || '';
    var options = (q.o || []).map(function (x) { return String(x); });
    var glosses = (opts && opts.glosses) || null;
    var out = [];
    var isCompletion = BLANK.test(stem);

    var sl = isCompletion && slot(stem);
    if (sl) {
      var needHe = { noun: 'שם עצם', adjective: 'שם תואר', adverb: 'תואר הפועל',
                     'base-verb': 'פועל בצורת המקור' }[sl.need];
      /* This rule POINTS, it does not eliminate. The grammar behind it is
         absolute, but deciding an English word's part of speech from its
         ending is not: `cure` ends like `failure` and is a verb, `fugitive`
         ends like `massive` and is a noun. Measured over the bank, eliminating
         by that morphology kept the right answer only 71% of the time — barely
         above blind guessing — so the hint states the requirement and leaves
         the judgement to the reader, who knows the words. */
      out.push({
        id: 'slot', hard: true, kills: [],
        title: 'מה המשבצת דורשת',
        body: 'המילה שלפני החסר היא "' + sl.cue + '". ' + sl.why + ' — כלומר צריך ' + needHe +
              '. עברו על ארבע התשובות ושאלו על כל אחת אם היא יכולה לתפקד כ' + needHe + '; מה שלא יכול, נפסל.',
      });
    }

    var cn = connective(stem);
    if (cn) {
      out.push({
        id: 'connective', hard: true, kills: [],
        title: cn.dir === 'reverse' ? 'שער היפוך' : 'שער המשכיות',
        body: 'במשפט מופיעה המילה "' + cn.word + '" (' + cn.he + '). ' +
          (cn.dir === 'reverse'
            ? 'היא הופכת את הכיוון: אם חצי המשפט האחד חיובי, החסר חייב להיות שלילי, ולהפך.'
            : 'היא שומרת על הכיוון: החסר חייב להדהד את מה שכבר נאמר במשפט, באותו סימן.'),
      });
    }

    var syn = synonymPairs(options, glosses);
    if (syn.length) {
      var kills = [];
      syn.forEach(function (p) { kills.push(p.i, p.j); });
      out.push({
        id: 'synonyms', hard: true, kills: kills,
        title: 'שתי תשובות נרדפות',
        body: syn.map(function (p) {
          return '"' + options[p.i] + '" ו-"' + options[p.j] + '" מתורגמות שתיהן ל"' + p.shared +
            '". בשאלה אמריקאית אין שתי תשובות נכונות, לכן שתיהן נפסלות.';
        }).join(' '),
      });
    }

    var da = isCompletion && definitionAnchor(stem);
    if (da) {
      out.push({
        id: 'definition', hard: false, kills: [],
        title: 'ההגדרה שתולה במשפט',
        body: 'יש סימן פיסוק (' + da.punct + ') ' + (da.where === 'after' ? 'מיד אחרי' : 'לפני') +
          ' החסר, ואחריו: "' + da.text + '". כשמבקשים מילה קשה, לרוב מסבירים אותה במילים פשוטות בדיוק שם.',
      });
    }

    var sa = soundAlikes(stem, options);
    if (sa.length) {
      out.push({
        id: 'soundalike', hard: false, kills: sa.map(function (x) { return x.i; }),
        title: 'מסיח הדהוד',
        body: sa.map(function (x) {
          return '"' + x.option + '" דומה מאוד ל-"' + x.like + '" שכבר במשפט.';
        }).join(' ') + ' מסיח כזה נועד למי שמנחש לפי מראה עיניים.',
      });
    }

    var pf = [];
    options.forEach(function (o, i) {
      if (/\s/.test(o.trim())) return;
      var p = prefixOf(o);
      if (p) pf.push({ i: i, option: o, p: p });
    });
    if (pf.length) {
      out.push({
        id: 'prefix', hard: false, kills: [],
        title: 'מה הקידומת מסגירה',
        body: pf.map(function (x) {
          return '"' + x.option + '" פותחת ב-' + x.p.prefix + '- (' + x.p.meaning + ', ' + x.p.polarity + ')';
        }).join(' · ') + '. גם בלי להכיר את המילה, הקידומת אומרת לאיזה צד היא נוטה.',
      });
    }

    var ex = extremes(options);
    if (ex.length) {
      out.push({
        id: 'extreme', hard: false, kills: ex.map(function (x) { return x.i; }),
        title: 'ניסוח מוחלט',
        body: ex.map(function (x) { return '"' + options[x.i] + '" מכילה "' + x.word + '"'; }).join(' · ') +
          '. אנגלית אקדמית נוטה להסתייג, ותשובה מוחלטת לרוב שגויה.',
      });
    }

    return out;
  }

  /** The options a set of hints would have eliminated, as a sorted list. */
  function killedBy(hints) {
    var seen = {};
    hints.forEach(function (h) { (h.kills || []).forEach(function (i) { seen[i] = 1; }); });
    return Object.keys(seen).map(Number).sort();
  }

  return {
    solveHints: solveHints,
    killedBy: killedBy,
    // exposed for measurement
    slot: slot, connective: connective, posOf: posOf, canBe: canBe,
    synonymPairs: synonymPairs, soundAlikes: soundAlikes, prefixOf: prefixOf,
    extremes: extremes, definitionAnchor: definitionAnchor, lookAlike: lookAlike,
    sameMeaning: sameMeaning, words: words,
  };
});
