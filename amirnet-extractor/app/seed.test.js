/* Lifts judgePrompt + seedFor out of exam.html and checks the seeded branch
   against the real trainer-words.json. */
const fs=require('fs'), path=require('path');
const APP=__dirname;
const html=fs.readFileSync(path.join(APP,'exam.html'),'utf8');

function lift(startMarker,endMarker){
  const a=html.indexOf(startMarker); const b=html.indexOf(endMarker,a);
  if(a<0||b<0) throw new Error('could not lift '+startMarker);
  return html.slice(a,b);
}
const src=lift('/* The course-authored hook','/* ---------- rendering ----------');
const run=new Function('TRAINER', src+'\n;return {judgePrompt:judgePrompt, seedFor:seedFor};');
const TRAINER=JSON.parse(fs.readFileSync(path.join(APP,'trainer-words.json'),'utf8'));
const api=run(TRAINER);

let fail=0;
const check=(c,m)=>{ if(!c){fail++;console.log('  FAIL: '+m)} else console.log('  ok  : '+m) };

const seeded=TRAINER.filter(w=>w.seed).map(w=>w.word);
check(seeded.length===5,'five words carry a course hook ('+seeded.join(', ')+')');

for(const w of seeded){
  const s=api.seedFor(w);
  check(!!s&&!!s.hook,'seedFor("'+w+'") returns the hook');
  const p=api.judgePrompt(w,'ניחוש',s);
  check(p.indexOf(s.hook)>0,'the prompt for "'+w+'" hands over the course hook');
  check(p.indexOf('במקום להמציא אחר')>0,'the prompt for "'+w+'" tells me not to invent a rival');
  check(p.indexOf('abduct')>0,'the prompt for "'+w+'" still carries the style example');
}

/* An unseeded word must come back clean — no empty "the course gave" line. */
const plain=TRAINER.find(w=>!w.seed).word;
check(api.seedFor(plain)===null,'seedFor("'+plain+'") is null for an unseeded word');
const pp=api.judgePrompt(plain,'ניחוש',api.seedFor(plain));
check(pp.indexOf('הקורס עצמו')<0,'an unseeded prompt says nothing about the course');
check(pp.indexOf('abduct')>0,'an unseeded prompt still carries the style example');
check(pp.indexOf('"'+plain+'"')>0,'the word itself reaches the prompt');

/* seedFor must not throw before the pool has loaded. */
check(run(null).seedFor('abandon')===null,'seedFor is safe before the pool loads');

console.log(fail?('\n'+fail+' FAILED\n'):'\nAll seed checks passed.\n');
process.exit(fail?1:0);
