'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {sendMailMessage}=require('../lib/mail-transport.cjs');
const settings={provider:'resend',from_email:'sender@example.test',api_key:'fake-never-transmitted'};
const message={id:'12345678-abcd-efgh-1234',to:'provider@example.test',subject:'MENTÁL.hu értesítés',text:'Tesztlevél, hálózati kapcsolat nélkül.'};
test('shared transport preserves contact reply address and stable provider idempotency',async()=>{
  let request;
  const sent=await sendMailMessage(settings,{...message,replyTo:'reader@example.test',scope:'mental-contact'},{fetchImpl:async(url,options)=>{request={url,options};return {ok:true,json:async()=>({id:'fake-provider-id'})};}});
  assert.equal(request.url,'https://api.resend.com/emails');
  assert.equal(request.options.headers['Idempotency-Key'],'mental-contact/'+message.id);
  const body=JSON.parse(request.options.body);assert.deepEqual(body.to,[message.to]);assert.equal(body.reply_to,'reader@example.test');assert.equal(body.text,message.text);assert.equal(sent.id,'fake-provider-id');
});
test('provider account mail omits reply address and supports an injected delivery transport',async()=>{
  let envelope;await sendMailMessage(settings,message,{transport:async value=>{envelope=value;return{id:'fake'};}});
  assert.equal(envelope.to,message.to);assert.equal(envelope.replyTo,undefined);assert.equal(envelope.subject,message.subject);assert.equal(envelope.headers,undefined);
});
test('uncertain network outcomes and rejected delivery are distinguishable',async()=>{
  await assert.rejects(sendMailMessage(settings,message,{fetchImpl:async()=>{throw Error('timeout');}}),{code:'MAIL_RESULT_UNCERTAIN'});
  await assert.rejects(sendMailMessage(settings,message,{fetchImpl:async()=>({ok:false,status:403})}),{code:'MAIL_HTTP_403'});
  await assert.rejects(sendMailMessage(settings,message,{fetchImpl:async()=>({ok:true,json:async()=>({})})}),{code:'MAIL_RESULT_UNCERTAIN'});
  await assert.rejects(sendMailMessage(settings,message,{fetchImpl:async()=>({ok:true,json:async()=>{throw Error('invalid response');}})}),{code:'MAIL_RESULT_UNCERTAIN'});
  await assert.rejects(sendMailMessage({...settings,api_key:''},message),{code:'MAIL_NOT_CONFIGURED'});
});
test('invalid recipient/header data is rejected before any network side effect',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw Error('must not be called');};
  for(const change of [{to:'bad\n@example.test'},{subject:'Bad\r\nBcc: someone@example.test'},{replyTo:'not-email'},{id:'bad/path'}])await assert.rejects(sendMailMessage(settings,{...message,...change},{fetchImpl}),{code:'INVALID_MAIL_ENVELOPE'});
  assert.equal(calls,0);
});

test('weekly newsletters carry one-click unsubscribe headers and a stable delivery identifier',async()=>{
  const unsubscribeUrl='https://mental.hu/leiratkozas/'+'a'.repeat(64);
  const expected={'List-Unsubscribe':'<'+unsubscribeUrl+'>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'};
  let body,requestHeaders;
  const digest={...message,scope:'mental-newsletter',unsubscribeUrl,html:'<p>Heti olvasnivalók</p>'};
  const fetchImpl=async(_url,options)=>{body=JSON.parse(options.body);requestHeaders=options.headers;return{ok:true,json:async()=>({id:'accepted-digest'})};};
  await sendMailMessage(settings,digest,{fetchImpl});
  assert.deepEqual(body.headers,expected);assert.equal(body.html,digest.html);
  assert.equal(requestHeaders['Idempotency-Key'],'mental-newsletter/'+message.id);
  await sendMailMessage({...settings,provider:'brevo'},digest,{fetchImpl});
  assert.deepEqual(body.headers,expected);assert.equal(body.htmlContent,digest.html);
  let envelope;await sendMailMessage(settings,digest,{transport:async value=>{envelope=value;return{id:'injected'};}});
  assert.deepEqual(envelope.headers,expected);
});

test('unsubscribe URL validation rejects redirects, credentials, control data and unsupported endpoints before send',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw Error('must not be called');};
  for(const unsubscribeUrl of [
    'https://mental.hu/leiratkozas/'+ 'a'.repeat(64)+'\r\nBcc: someone@example.test',
    'http://mental.hu/leiratkozas/'+ 'a'.repeat(64),
    'https://user:secret@mental.hu/leiratkozas/'+ 'a'.repeat(64),
    'https://mental.hu/leiratkozas/'+ 'a'.repeat(64)+'?redirect=https://example.test',
    'https://mental.hu/leiratkozas/'+ 'a'.repeat(64)+'#token',
    'https://mental.hu/other/'+ 'a'.repeat(64),
    'mailto:someone@example.test',
    'https://mental.hu/leiratkozas/short',
    {headers:{Bcc:'someone@example.test'}}
  ])await assert.rejects(sendMailMessage(settings,{...message,unsubscribeUrl},{fetchImpl}),{code:'INVALID_UNSUBSCRIBE_URL'});
  assert.equal(calls,0);
});
