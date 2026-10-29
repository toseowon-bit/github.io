const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const html = readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach(script => new vm.Script(script));
const database = scripts.find(s => s.includes('const rawData')).match(/const rawData = (\[[\s\S]*?\n        \]);/)[1];
const data = vm.runInNewContext(database);
const quiz = scripts.at(-1);
const KEY = 'english_200_quiz_v1';
function app(store = new Map(), clock = {now: '2026-10-29T12:00:00'}, blocked = false) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {innerHTML:'', textContent:'', handlers:{}, addEventListener(type, fn) {this.handlers[type] = fn;}, setAttribute(){}, querySelector(){return {focus(){}};}});
    return nodes.get(id);
  };
  const calls = [];
  const document = {getElementById:get, addEventListener(){}, hidden:false};
  class ClockDate extends Date {constructor(...args) {super(...(args.length ? args : [clock.now]));}}
  const context = {rawData: data, document, Date: ClockDate, escapeHtml:s=>s, stopSpeaking(){}, speakEnglish:(...args)=>calls.push(args), localStorage:{getItem:key=>store.get(key)||null, setItem:(key,value)=>{if(blocked)throw Error('quota');store.set(key,value);}}};
  vm.runInNewContext(quiz, context);
  const click = action => get('quiz-content').handlers.click({target:{closest:()=>({dataset:{quizAction:action}})}});
  const tab = name => get('quiz-'+name).handlers.click();
  const answer = correct => {click('reveal'); click(correct ? 'correct':'wrong');};
  return {store, clock, click, tab, answer, calls, node:get, state:()=>JSON.parse(store.get(KEY)), ui:()=>get('quiz-content').innerHTML};
}
test('200 original sentences; reveal required, voice reuses exact sentence id; legacy data unchanged', () => {
  assert.equal(data.length,200);
  const store = new Map([['english_200_learned','{"5":true}'],['english_200_voice','legacy'],['theme','dark']]);
  const a=app(store); a.click('correct'); assert.deepEqual(a.state().stats,{});
  assert.ok(!a.ui().includes(data[0].en)); a.click('reveal'); assert.ok(a.ui().includes(data[0].en));
  a.click('speak'); assert.deepEqual(a.calls[0],[data[0].en,1]); a.click('wrong');
  assert.equal(a.state().stats[1].wrong,1); assert.equal(store.get('english_200_learned'),'{"5":true}');
  assert.equal(store.get('english_200_voice'),'legacy'); assert.equal(store.get('theme'),'dark');
});
test('resume daily progress after reload, finish exactly 10 and move to next set tomorrow', () => {
  let a=app(); a.answer(false); a=app(a.store); assert.match(a.ui(),/#2</);
  for(let i=1;i<10;i++) a.answer(true);
  assert.match(a.ui(),/오늘의 10문장 완료/); assert.equal(Object.keys(a.state().stats).length,10);
  a=app(a.store); assert.match(a.ui(),/오늘의 10문장 완료/);
  a.clock.now='2026-10-30T12:00:00'; a.tab('daily'); assert.match(a.ui(),/DAY 2/); assert.match(a.ui(),/#11</);
});
test('incorrect review resumes, removes corrected items but preserves lifetime wrong counts', () => {
  let a=app(); a.answer(false); a.answer(false); a.tab('wrong'); a.answer(true);
  a=app(a.store); a.tab('wrong'); assert.match(a.ui(),/#2</); a.answer(false);
  assert.match(a.ui(),/오답 복습 완료/); a.click('review'); assert.match(a.ui(),/#2</); a.answer(true);
  assert.equal(a.state().stats[1].lastCorrect,true); assert.equal(a.state().stats[1].wrong,1);
  assert.equal(a.state().stats[2].wrong,2); assert.match(a.ui(),/남은 오답이 없어요/);
});
test('all 20 sets cover all 200 ids once and repeat after completion', () => {
  let store = new Map(); const seen = new Set();
  for(let day=0;day<21;day++) {
    const a=app(store,{now:new Date(Date.UTC(2026,10,1+day,12)).toISOString()});
    const run=Object.values(a.state().days).at(-1);
    if(day<20) for(const id of run.ids) { assert.ok(!seen.has(id)); seen.add(id); }
    else assert.equal(run.set,0);
    for(let n=0;n<10;n++)a.answer(true);
  }
  assert.equal(seen.size,200);
});
test('incomplete set is offered again next day and midnight cannot grade unseen prompt', () => {
  const a=app(); a.answer(true); a.click('reveal'); a.clock.now='2026-10-30T12:00:00'; a.click('correct');
  assert.equal(a.state().stats[1].correct,1); assert.equal(a.state().stats[2],undefined);
  assert.equal(a.state().days['2026-10-30'].set,0); assert.match(a.ui(),/#1</);
});
test('malformed storage is preserved; blocked writes still allow learning', () => {
  const store=new Map([[KEY,'{broken'],['english_200_learned','{"1":true}']]);
  const a=app(store); a.answer(true); assert.equal(store.get(KEY),'{broken'); assert.match(a.node('quiz-storage-message').textContent,/読み|읽을/);
  const b=app(new Map(),undefined,true); b.answer(false); assert.match(b.ui(),/#2</); assert.match(b.node('quiz-storage-message').textContent,/저장하지 못/);
});
