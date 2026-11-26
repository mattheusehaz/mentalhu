'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {RECIPIENT, notificationMessage, createSubmissionNotificationService} = require('../lib/submission-notifications.cjs');

const applicant = {
  id:'42', submission_id:'42', revision:1, event_type:'new',
  name:'Teszt rendelő', contact_name:'Teszt Kapcsolattartó', email:'applicant@example.test',
  phone:'+36 20 555 0100', website_url:'https://example.test/rendelo',
  category_slugs:'pszichologusok,mentalhigienes-szakemberek',
  category_names:['Pszichológusok','Mentálhigiénés szakemberek'],
  city:'Budapest', online_available:true,
  description:'Kizárólag izolált tesztben használt szakmai bemutatkozás.',
  qualifications:'Teszt képesítés', created_at:'2026-11-26T12:30:00.000Z',
  consent:true, status:'new', deleted_at:null
};

test('catalog notifications use the exact owner address and an authenticated admin deep link', () => {
  assert.equal(RECIPIENT,'den@proptechdigital.com');
  const message = notificationMessage({...applicant,recipient:'intruder@example.test',to:'intruder@example.test'});
  assert.equal(message.to,RECIPIENT);
  assert.equal(message.replyTo,applicant.email);
  assert.equal(message.scope,'mental-submission');
  for (const expected of [applicant.name,applicant.contact_name,applicant.email,applicant.phone,applicant.city,
    applicant.description,'Pszichológusok','Mentálhigiénés szakemberek']) assert(message.text.includes(expected),expected);
  const links = message.text.match(/https?:\/\/[^\s<>]+/g) || [];
  const admin = links.map(value => new URL(value)).find(url => url.origin==='https://mental.hu' && url.pathname==='/admin/');
  assert(admin,'Notification must contain the private admin entry point');
  assert.equal(admin.searchParams.get('submission'),'42');
  assert(!admin.href.includes(applicant.email));
  assert(!admin.href.includes(encodeURIComponent(applicant.email)));
  assert(!message.subject.includes(applicant.name),'Subject remains independent of untrusted applicant input');
});

test('untrusted application fields cannot add mail headers or alter recipient and control link', () => {
  const message = notificationMessage({...applicant,
    name:'Név\r\nBcc: attacker@example.test',
    email:'valid@example.test\r\nBcc: attacker@example.test',
    contact_name:'<img src=x onerror=alert(1)>',
    recipient:'attacker@example.test',
    admin_url:'https://attacker.example/private',
    description:'<script>fetch("https://attacker.example")</script>'
  });
  assert.equal(message.to,RECIPIENT);
  assert(!message.replyTo,'Invalid applicant address cannot become a Reply-To header');
  assert(!/[\r\n\0]/.test(message.subject));
  assert(message.subject.length>0 && message.subject.length<=240);
  assert.equal(message.html,undefined,'Applicant input is delivered as plain text');
  assert(message.text.includes('https://mental.hu/admin/'));
  assert(!message.text.includes('https://attacker.example/private'));
});

test('the worker does no database work or sending before migrations are ready', async () => {
  let calls=0;
  const unexpected=async()=>{calls++;throw Error('Unexpected work before database readiness');};
  const service=createSubmissionNotificationService({
    pool:{query:unexpected,connect:unexpected}, dbState:{ready:false},
    auth:()=>{},accounts:{protect:()=>{}},mailer:{ready:unexpected,send:unexpected}
  });
  await service.runWorker();
  assert.equal(calls,0);
  service.stop();
});
