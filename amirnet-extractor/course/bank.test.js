/* Integrity of the merged course bank: the drill sheets, whose answers were
   determined here, and the worked-solution guides, whose answers the course
   itself stamps into each question's heading.

   node course/bank.test.js */
const b = require('../app/course-bank.json');
const hooks = require('./guide-hooks.json');
const trainer = require('../app/trainer-words.json');

let fail = 0;
const check = (c, m) => { if (!c) { fail++; console.log('  FAIL: ' + m); } else console.log('  ok  : ' + m); };

console.log(`=== course bank (${b.length} questions) ===`);
check(b.every((q) => typeof q.a === 'number' && q.a >= 0 && q.a < q.o.length), 'every answer index is in range');
check(b.every((q) => q.o.length === 4), 'every question has four options');
check(b.every((q) => new Set(q.o.map((o) => o.toLowerCase())).size === 4), 'no question repeats an option');
check(b.every((q) => q.p && q.p.length > 20), 'every stem is a real sentence');
check(b.every((q) => ['easy', 'medium', 'hard', 'expert'].includes(q.d)), 'every difficulty is a known level');
check(b.every((q) => q.t === 'sentence_completion' || q.t === 'restatement'), 'every type is one the app serves');

const fps = b.map((q) => q.p.toLowerCase().replace(/[^a-z]/g, '').slice(0, 60));
check(new Set(fps).size === fps.length, `no duplicate stems (${fps.length - new Set(fps).size} found)`);

console.log('\n=== provenance ===');
const byWho = b.reduce((m, q) => ((m[q.answerBy] = (m[q.answerBy] || 0) + 1), m), {});
check(byWho.course === 240, `${byWho.course} questions carry the course's own key`);
check(byWho.claude === 216, `${byWho.claude} carry a key determined here, recorded as such`);
check(b.every((q) => q.answerBy === 'course' || q.answerBy === 'claude'), 'every question says where its answer came from');
check(b.filter((q) => q.src === 'course-guide').every((q) => q.answerBy === 'course'),
  'no guide question is credited to me');

console.log('\n=== shape by type ===');
const sc = b.filter((q) => q.t === 'sentence_completion');
const rs = b.filter((q) => q.t === 'restatement');
check(sc.every((q) => /_{3,}/.test(q.p)), `all ${sc.length} completion stems carry their blank`);
check(sc.every((q) => q.v.length === 1 && q.o[q.a].toLowerCase() === q.v[0]), 'completion vocab points at its own answer');
check(sc.every((q) => q.o.every((o) => o.split(' ').length <= 5)), 'completion options are words or short phrases');
check(rs.length === 80 && rs.every((q) => q.v.length === 0), 'restatement carries no vocab tag');
check(rs.every((q) => q.o.every((o) => o.split(' ').length >= 3)), 'restatement options are clauses, not single words');

console.log('\n=== the hooks the guides teach ===');
check(hooks.length > 600, `${hooks.length} distinct words carry a course-authored hook`);
check(hooks.every((h) => /^[a-z][a-z'-]*$/.test(h.word)), 'every hook headword is a clean lowercase word');
check(hooks.every((h) => /[֐-׿]/.test(h.hook)), 'every hook is written in Hebrew');
const seeded = trainer.filter((w) => w.seed);
check(seeded.length > 600, `${seeded.length} trainer words open with a course hook`);
check(seeded.every((w) => w.seed.hook && w.seed.hookBy === 'course'), 'every seed credits the course');
const firstOnes = trainer.filter((w) => w.times === 1).slice(0, 50);
check(firstOnes.every((w) => w.seed), 'among equally rare words the course-taught ones come first');

console.log(fail ? `\n${fail} FAILED\n` : '\nCourse bank clean.\n');
process.exit(fail ? 1 : 0);
