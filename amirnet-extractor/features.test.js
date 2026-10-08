'use strict';
const fs=require('fs');
const html=fs.readFileSync('/home/user/general-app-env/amirnet-extractor/app/exam.html','utf8');
const script=html.match(/<script>([\s\S]*)<\/script>/)[1];

const scoring=script.match(/\/\* =+ SCORE ESTIMATE =+ \*\/[\s\S]*?(?=\/\* =+ ADAPTIVE ENGINE =+ \*\/)/)[0];
const api=new Function(scoring+'\nreturn {estimateScore:estimateScore,bandOf:bandOf,WEIGHT:WEIGHT,BANDS:BANDS};')();

let fail=0; const check=(c,m)=>{if(!c){fail++;console.log('  FAIL: '+m)}};
const rows=(n,diff,rightFrac)=>Array.from({length:n},(_,i)=>({ok:i<Math.round(n*rightFrac),q:{d:diff}}));

console.log('=== score anchors (23 questions, all correct) ===');
for(const [d,expect] of [['easy',75],['medium',100],['hard',125],['expert',150]]){
  const s=api.estimateScore(rows(23,d,1));
  console.log('  all correct at '+d.padEnd(7)+'-> '+String(s).padStart(3)+'  ('+api.bandOf(s).name+')');
  check(s===expect, `all-correct ${d} should be ${expect}, got ${s}`);
}
console.log('\n=== partial performance ===');
for(const [d,f] of [['medium',0.6],['hard',0.7],['expert',0.5],['easy',0.5],['expert',0.87]]){
  const s=api.estimateScore(rows(23,d,f));
  console.log('  '+String(Math.round(f*100)).padStart(3)+'% at '+d.padEnd(7)+'-> '+String(s).padStart(3)+'  '+api.bandOf(s).name);
}
console.log('\n=== monotonicity ===');
let prev=0, mono=true;
for(let f=0;f<=1.0001;f+=0.1){ const s=api.estimateScore(rows(23,'hard',f)); if(s<prev)mono=false; prev=s }
check(mono,'score must never decrease as accuracy rises');
let pl=0, mono2=true;
for(const d of ['easy','medium','hard','expert']){ const s=api.estimateScore(rows(23,d,1)); if(s<pl)mono2=false; pl=s }
check(mono2,'score must rise with difficulty at equal accuracy');
check(api.estimateScore([])===50,'empty run should floor at 50');
check(api.estimateScore(rows(23,'easy',0))===50,'all wrong should floor at 50');
console.log('  monotone in accuracy:',mono,'| monotone in difficulty:',mono2);

console.log('\n=== bands cover 50..150 with no gaps ===');
let gaps=[];
for(let s=50;s<=150;s++){ const b=api.bandOf(s); if(!b) gaps.push(s) }
check(gaps.length===0,'ungraded scores: '+gaps.join(','));
console.log('  every score 50..150 maps to a band:',gaps.length===0);
for(const b of api.BANDS) console.log('   '+String(b.min).padStart(3)+'+  '+b.name);

/* ---- cross-sitting freshness, using the real draw() ---- */
console.log('\n=== freshness across sittings (real engine) ===');
const engine=script.match(/\/\* =+ ADAPTIVE ENGINE =+ \*\/[\s\S]*?(?=\/\* =+ EXAM =+ \*\/)/)[0];
const sectionTime=script.match(/function sectionTime\(sec\)\{[\s\S]*?\n\}/)[0];
const DATA=JSON.parse(fs.readFileSync('/home/user/general-app-env/amirnet-extractor/app/simulations.json','utf8'));
const settings={useCustom:false,times:{}};
let seenBank={};
const store={};
const COURSE_DATA=JSON.parse(fs.readFileSync('/home/user/general-app-env/amirnet-extractor/app/course-bank.json','utf8'));
const run=new Function('DATA','settings','COURSE','getSeen','setSeen',
  'var S;var seenBank=getSeen();'+
  'function save(){};function load(k,d){return d};'+
  'function markSeen(keys){keys.forEach(function(k){seenBank[k]=1});setSeen(seenBank)}'+
  'function seenCount(){var n=0;for(var k in seenBank)n++;return n}'+
  sectionTime+'\n'+engine+
  '\nreturn {buildBank:buildBank,buildAdaptiveSection:buildAdaptiveSection,LEVELS:LEVELS,'+
  'ADAPTIVE_PLAN:ADAPTIVE_PLAN,keyOf:keyOf,setS:function(v){S=v},seen:function(){return seenBank}};');
const eng=run(DATA, settings, COURSE_DATA, ()=>seenBank, v=>{seenBank=v});
eng.buildBank();

function sitting(level){
  eng.setS({used:{},sections:[],adaptive:true});
  const keys=[];
  eng.ADAPTIVE_PLAN.forEach((t,i)=>{
    const sec=eng.buildAdaptiveSection(i,level);
    sec.qs.forEach(q=>keys.push(q.p+'|'+(q.o[0]||'')));
  });
  return keys;
}
const allSittings=[];
for(let i=0;i<6;i++) allSittings.push(sitting(1));   // six sittings, all at medium
for(let i=1;i<allSittings.length;i++){
  const prev=new Set(allSittings.slice(0,i).flat());
  const overlap=allSittings[i].filter(k=>prev.has(k)).length;
  console.log('  sitting '+(i+1)+': '+allSittings[i].length+' questions, '+overlap+' repeated from earlier');
  if(i<5) check(overlap===0, `sitting ${i+1} should be fully fresh, had ${overlap} repeats`);
}
console.log('  seen bank now holds', Object.keys(eng.seen()).length, 'keys');

console.log(fail===0?'\nAll checks passed.\n':`\n${fail} CHECK(S) FAILED\n`);
process.exit(fail?1:0);
