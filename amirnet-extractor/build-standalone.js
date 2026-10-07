'use strict';

/**
 * build-standalone.js — one self-contained HTML file.
 *
 * The published page fetches its question bank and word lists as separate
 * files, which needs a server. This folds all of them, and hints.js, into a
 * single document that can be sent to someone directly and opened from their
 * phone with no account, no permissions and no network.
 *
 * exam.html is not modified to do this. A small shim installed ahead of it
 * answers the page's own fetch() calls from the inlined data, keyed by
 * filename, and falls through to the real fetch for anything else — so the one
 * file and the published page stay the same program.
 */

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, 'app');
const OUT = path.join(APP, 'amirnet-standalone.html');

const DATA = ['simulations.json', 'vocabulary.json', 'trainer-words.json', 'course-bank.json'];

function kb(n) { return (n / 1024).toFixed(0) + 'KB'; }

function main() {
  let html = fs.readFileSync(path.join(APP, 'exam.html'), 'utf8');

  const bundle = {};
  for (const f of DATA) bundle[f] = JSON.parse(fs.readFileSync(path.join(APP, f), 'utf8'));

  /* `</script>` inside a JSON string would close the tag early. */
  const json = JSON.stringify(bundle).replace(/<\//g, '<\\/');

  const shim =
    '<script>\n' +
    '/* Inlined data, so this file needs no server. The page is unchanged: its\n' +
    '   fetch() calls are answered from here by filename, and anything else\n' +
    '   falls through to the real fetch. */\n' +
    'window.__BUNDLE=' + json + ';\n' +
    '(function(){\n' +
    '  var real = typeof fetch === "function" ? fetch.bind(window) : null;\n' +
    '  window.fetch = function(url){\n' +
    '    var key = String(url).split("?")[0].split("/").pop();\n' +
    '    if (Object.prototype.hasOwnProperty.call(window.__BUNDLE, key)) {\n' +
    '      var body = window.__BUNDLE[key];\n' +
    '      return Promise.resolve({ ok:true, status:200,\n' +
    '        json: function(){ return Promise.resolve(body) },\n' +
    '        text: function(){ return Promise.resolve(JSON.stringify(body)) } });\n' +
    '    }\n' +
    '    return real ? real.apply(null, arguments)\n' +
    '                : Promise.reject(new Error("no network in the standalone file"));\n' +
    '  };\n' +
    '})();\n' +
    '</script>\n';

  /* hints.js is a plain script tag; inline its source in place. */
  const hints = fs.readFileSync(path.join(APP, 'hints.js'), 'utf8');
  if (!html.includes('<script src="hints.js"></script>')) {
    throw new Error('exam.html no longer loads hints.js the way this build expects');
  }
  html = html.replace('<script src="hints.js"></script>', '<script>\n' + hints + '\n</script>');

  /* The shim must run before the page's own script, and before hints.js so the
     document order matches the served page. */
  const anchor = '<script>\n';
  const at = html.indexOf(anchor);
  if (at < 0) throw new Error('could not find where to install the shim');
  html = html.slice(0, at) + shim + html.slice(at);

  /* Say what this file is, for whoever opens it months from now. */
  html = html.replace('<title>',
    '<!--\n' +
    '  חדר מבחן אמירנט — קובץ אחד, עצמאי.\n' +
    '  נבנה מ-app/exam.html בתוספת מאגרי השאלות והמילים, שמוטמעים כאן.\n' +
    '  אפשר לפתוח אותו מכל דפדפן, גם בלי אינטרנט ובלי חשבון.\n' +
    '  ההתקדמות נשמרת בדפדפן של מי שפתח אותו, ולא נשלחת לשום מקום.\n' +
    '  מה שלא עובד כאן: שיפוט הניחוש במאמן המילים, שדורש חיבור ל-Claude.\n' +
    '-->\n<title>');

  fs.writeFileSync(OUT, html, 'utf8');

  const parts = DATA.map((f) => f + ' ' + kb(fs.statSync(path.join(APP, f)).size)).join(' · ');
  console.log('Wrote ' + path.relative(process.cwd(), OUT) + ' — ' + kb(fs.statSync(OUT).size));
  console.log('  inlined: ' + parts + ' · hints.js ' + kb(hints.length));
}

if (require.main === module) main();
module.exports = { main };
