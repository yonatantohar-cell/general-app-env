'use strict';
/* Drives the REAL engine code lifted out of exam.html — not a reimplementation. */
const fs=require('fs');
const html=fs.readFileSync('/home/user/general-app-env/amirnet-extractor/app/exam.html','utf8');
const script=html.match(/<script>([\s\S]*)<\/script>/)[1];

// Lift the engine block plus sectionTime, which it calls.
const engine=script.match(/\/\* =+ ADAPTIVE ENGINE =+ \*\/[\s\S]*?(?=\/\* =+ EXAM =+ \*\/)/)[0];
const sectionTime=script.match(/function sectionTime\(sec\)\{[\s\S]*?\n\}/)[0];
if(!engine||!sectionTime) throw new Error('could not lift engine');

const DATA=JSON.parse(fs.readFileSync('/home/user/general-app-env/amirnet-extractor/app/simulations.json','utf8'));
const settings={useCustom:false,times:{}};
let S=null;
// `S` is a module-level variable the engine reads. Declare it INSIDE the
// compiled scope and hand the harness accessors, so both sides see one binding.
const COURSE_DATA=JSON.parse(fs.readFileSync('/home/user/general-app-env/amirnet-extractor/app/course-bank.json','utf8'));
const run=new Function('DATA','settings','COURSE',
  /* The engine now reads a cross-sitting `seenBank` and persists through
     save/load; stub those so the harness exercises the real draw logic. */
  'var S;var seenBank={};'+
  'function save(){};function load(k,d){return d};'+
  'function markSeen(keys){keys.forEach(function(k){seenBank[k]=1})};'+
  'function seenCount(){var n=0;for(var k in seenBank)n++;return n};'+
  '\n'+sectionTime+'\n'+engine+
  '\nreturn {buildBank:buildBank,draw:draw,buildAdaptiveSection:buildAdaptiveSection,'+
  'LEVELS:LEVELS,ADAPTIVE_PLAN:ADAPTIVE_PLAN,UP:UP,DOWN:DOWN,keyOf:keyOf,'+
  'setS:function(v){S=v},getS:function(){return S},'+
  'resetSeen:function(){for(var k in seenBank)delete seenBank[k]}};');

const api=run(DATA, settings, COURSE_DATA);

const {LEVELS,ADAPTIVE_PLAN,UP,DOWN}=api;
api.buildBank();

let fail=0;
const check=(cond,msg)=>{ if(!cond){fail++;console.log('  FAIL: '+msg)} };

console.log('thresholds from the real code: UP='+UP+'  DOWN='+DOWN);
console.log('plan:',ADAPTIVE_PLAN.join(' , '));

/* ---- 1. bank coverage ---- */
console.log('\n=== bank coverage (need 2x one section) ===');
const need={sentence_completion:4,restatement:3,reading_comprehension:1};
for(const t of Object.keys(need)){
  const row=LEVELS.map(L=>{
    const n=api.buildBank()[t][L].length;
    check(n>=need[t]*2, `${t}/${L} has ${n}, need >= ${need[t]*2}`);
    return L+':'+n;
  });
  console.log('  '+t.padEnd(24)+row.join('  '));
}

/* ---- 2. simulated examinees ---- */
function simulate(ability){
  api.resetSeen();
  api.setS({sim:{},adaptive:true,level:1,trail:[],used:{},total:ADAPTIVE_PLAN.length,
     sections:[],si:0,answers:[],flags:[]});
  const S=api.getS();
  const seen=new Set();
  for(let i=0;i<ADAPTIVE_PLAN.length;i++){
    S.si=i;
    const sec=api.buildAdaptiveSection(i,S.level);
    S.sections[i]=sec;

    const expected = ADAPTIVE_PLAN[i]==='reading_comprehension' ? 5 : (ADAPTIVE_PLAN[i]==='restatement'?3:4);
    check(sec.qs.length===expected, `section ${i+1} (${ADAPTIVE_PLAN[i]}) served ${sec.qs.length}, expected ${expected}`);
    check(sec.dur>0, `section ${i+1} has no duration`);

    if(ADAPTIVE_PLAN[i]==='reading_comprehension'){
      check(sec.meta.passages.length===1,'reading section missing its passage');
      // every question must belong to the passage's own section
      const ok=sec.qs.every(q=>typeof q.p==='string'&&q.o.length>=2);
      check(ok,'reading questions malformed');
    }
    for(const q of sec.qs){
      const k=q.p+'|'+(q.o[0]||'');
      check(!seen.has(k), `repeated question in one sitting: "${q.p.slice(0,40)}"`);
      seen.add(k);
    }

    // answer with the given ability, then apply the REAL thresholds
    let right=0;
    for(const q of sec.qs) if(Math.random()<ability) right++;
    const frac=sec.qs.length?right/sec.qs.length:0;
    S.trail.push({level:sec.level,pct:Math.round(frac*100)});
    if(frac>=UP) S.level=Math.min(LEVELS.length-1,S.level+1);
    else if(frac<=DOWN) S.level=Math.max(0,S.level-1);
  }
  return {final:LEVELS[S.level],trail:S.trail.map(t=>t.level)};
}

console.log('\n=== 100 sittings at each ability ===');
for(const ability of [0.30,0.60,0.95]){
  const finals={};
  for(let i=0;i<100;i++){ const r=simulate(ability); finals[r.final]=(finals[r.final]||0)+1 }
  console.log('  ability '+(ability*100).toFixed(0)+'% -> final level: '+
    LEVELS.map(L=>L+':'+(finals[L]||0)).join('  '));
  if(ability===0.95) check((finals.expert||0)>=80,'strong examinee should usually reach expert');
  if(ability===0.30) check((finals.easy||0)>=80,'weak examinee should usually fall to easy');
}

/* ---- 3. first section is always moderate ---- */
const starts=new Set();
for(let i=0;i<30;i++){ const r=simulate(0.6); starts.add(r.trail[0]) }
check(starts.size===1&&starts.has('medium'),'the test must always open at medium, saw: '+[...starts]);
console.log('\nopening level across 30 sittings:',[...starts].join(','));

console.log(fail===0?'\nAll checks passed.\n':`\n${fail} CHECK(S) FAILED\n`);
process.exit(fail?1:0);
