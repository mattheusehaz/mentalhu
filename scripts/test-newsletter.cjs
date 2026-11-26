'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {fridaySlot,editionWindow,localParts,signupData,parsePreviewTopics,deliveryOutcome,csvCell,SEND_HOUR}=require('../lib/newsletter.cjs');
const {normalizeTopics,articleMatchesTopics}=require('../lib/newsletter-topics.cjs');
const {digestMessage,confirmationMessage}=require('../lib/newsletter-mail.cjs');

test('Friday delivery follows Budapest 08:00 including both DST transitions',()=>{
  assert.equal(SEND_HOUR,8);
  assert.equal(fridaySlot('2026-11-27T06:59:59Z').toISOString(),'2026-11-20T07:00:00.000Z');
  assert.equal(fridaySlot('2026-11-27T07:00:00Z').toISOString(),'2026-11-27T07:00:00.000Z');
  assert.equal(fridaySlot('2026-11-26T20:00:00Z',true).toISOString(),'2026-11-27T07:00:00.000Z');
  const spring=editionWindow('2026-04-03T06:00:01Z'),autumn=editionWindow('2026-10-30T07:00:01Z');
  assert.equal((spring.end-spring.start)/3600000,167);
  assert.equal((autumn.end-autumn.start)/3600000,169);
  for(const window of [spring,autumn]){
    assert.equal(localParts(window.start).hour,8);assert.equal(localParts(window.end).hour,8);
    assert.equal(editionWindow(new Date(window.start.valueOf()+1000)).end.toISOString(),window.start.toISOString(),'Adjacent weekly windows share exactly one boundary');
  }
});

test('signup needs a real name, normalized mailbox, selected known topics and explicit consent',()=>{
  const data=signupData({name:'  Teszt   Olvasó  ',email:'  Reader@Example.Test ',topics:['adhd','alvas','adhd'],consent:true});
  assert.equal(data.name,'Teszt Olvasó');assert.equal(data.email,'reader@example.test');assert.deepEqual(data.topics,['adhd','alvas']);
  for(const override of [{name:'x'},{name:'Bad\nName'},{email:'a..b@example.test'},{email:'a@-example.test'},{email:'a@example.test\nBcc: other@example.test'},{topics:[]},{topics:['unknown']},{consent:'true'},{consent:false}]){
    assert.throws(()=>signupData({name:'Olvasó',email:'reader@example.test',topics:['all'],consent:true,...override}));
  }
  assert.deepEqual(normalizeTopics(['alvas','all']),['all']);
  assert.deepEqual(parsePreviewTopics('alvas,kapcsolatok'),['alvas','kapcsolatok']);
  assert.throws(()=>parsePreviewTopics('alvas,bogus'));
});

test('topics select matching editorial articles and retain legacy labels',()=>{
  assert(articleMatchesTopics({title:'Alvás',category:'Alvás'},['alvas']));
  assert(!articleMatchesTopics({title:'Alvás',category:'Alvás'},['kapcsolatok']));
  assert(articleMatchesTopics({title:'Munka',category:'Munka'},['munka-es-kieges']));
  assert(articleMatchesTopics({title:'Bármi',category:'Új rovat'},['all']));
  assert(!articleMatchesTopics({title:'Bármi',category:'Új rovat'},['adhd']));
});

test('unknown delivery results never automatically retry, only definite throttling can retry',()=>{
  for(const code of ['MAIL_RESULT_UNCERTAIN','ETIMEDOUT','ECONNECTION','MAIL_HTTP_500','MAIL_HTTP_408','UNKNOWN'])assert.equal(deliveryOutcome({code},1).status,'uncertain');
  assert.equal(deliveryOutcome({code:'MAIL_HTTP_429'},1).status,'queued');
  assert.equal(deliveryOutcome({code:'MAIL_HTTP_429'},3).status,'failed');
  assert.equal(deliveryOutcome({code:'MAIL_NOT_CONFIGURED'},1).status,'needs_mail');
  assert.equal(deliveryOutcome({code:'EAUTH'},1).status,'failed');
  assert.equal(deliveryOutcome({},1).status,'uncertain');
});

test('branded message escapes supplied content and uses working article, preferences and opt-out links',()=>{
  const message=digestMessage({id:'digest-test-123',to:'reader@example.test',name:'<Olvasó>',topics:['Alvás'],windowStart:'2026-11-20',windowEnd:'2026-11-27',
    articles:[{id:1,slug:'alvas-kutatas',title:'<script>alert(1)</script>',excerpt:'& friss kutatás',category:'Alvás',hero_url:'https://external.example/tracking.png',reading_minutes:4}],
    preferencesUrl:'https://mental.hu/hirlevel/beallitasok#token=abc',unsubscribeUrl:'https://mental.hu/leiratkozas/'+'a'.repeat(64)});
  assert(message.html.includes('/assets/mental-newsletter-logo.png'));assert(message.html.includes('&lt;script&gt;'));
  assert(!message.html.includes('<script>'));assert(!message.html.includes('external.example'));
  assert(message.text.includes('https://mental.hu/cikk/alvas-kutatas'));assert(message.text.includes('Leiratkozás:'));
  assert(message.unsubscribeUrl.endsWith('a'.repeat(64)));
  assert.throws(()=>digestMessage({id:'digest-test-123',to:'reader@example.test',articles:[]}));
  const confirmation=confirmationMessage({id:'confirm-test-123',to:'reader@example.test',name:'Olvasó',topics:['Alvás'],confirmationUrl:'https://mental.hu/hirlevel/megerosites#token=abc'});
  assert(confirmation.text.includes('/hirlevel/megerosites#token=abc'));assert(!confirmation.unsubscribeUrl);
});

test('subscriber CSV guards spreadsheet formula injection and quotes cells',()=>{
  assert.equal(csvCell('=HYPERLINK("https://example.test")'),'"\'=HYPERLINK(""https://example.test"")"');
  assert.equal(csvCell('+123'),'"\'+123"');
  assert.equal(csvCell('Olvasó\nNév'),'"Olvasó Név"');
});
