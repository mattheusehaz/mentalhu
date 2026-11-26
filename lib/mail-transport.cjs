'use strict';

const EMAIL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
const validEmail = value => typeof value === 'string' && value.length <= 254 && EMAIL.test(value) && !/[\r\n\0]/.test(value);
const error = (code, status = 502) => Object.assign(new Error(code), {code, httpStatus:status});

async function sendMailMessage(settings, message, {transport = null, fetchImpl = fetch} = {}) {
  const {id, to, subject, text, html, replyTo, replyToName, scope = 'mental-account'} = message;
  if (!validEmail(to) || !validEmail(settings.from_email) || !/^[a-zA-Z0-9_-]{8,140}$/.test(id || '') ||
      typeof subject !== 'string' || !subject || subject.length > 240 || /[\r\n\0]/.test(subject) ||
      typeof text !== 'string' || !text || text.length > 70000 || (replyTo && !validEmail(replyTo)) ||
      (html != null && (typeof html !== 'string' || html.length > 120000)) || !/^[a-z-]{3,50}$/.test(scope)) {
    throw error('INVALID_MAIL_ENVELOPE', 400);
  }
  const envelope = {to, from:settings.from_email, ...(replyTo ? {replyTo} : {}), subject, text, id, ...(html ? {html} : {})};
  if (transport) return transport(envelope);
  if (settings.provider === 'smtp') {
    const nodemailer = require('nodemailer');
    const client = nodemailer.createTransport({host:settings.smtp_host,port:settings.smtp_port,secure:settings.smtp_port === 465,requireTLS:true,
      auth:{user:settings.smtp_user,pass:settings.smtp_password},tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},
      connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000,disableFileAccess:true,disableUrlAccess:true});
    try {
      const result = await client.sendMail({from:{name:'MENTÁL.hu',address:settings.from_email},to:{address:to},
        ...(replyTo ? {replyTo:{name:replyToName || '',address:replyTo}} : {}),subject,text,...(html ? {html} : {}),
        messageId:'<' + id + '@mental.hu>',disableFileAccess:true,disableUrlAccess:true});
      if (!result.accepted?.length) throw error('MAIL_REJECTED');
      return {id:result.messageId};
    } finally { client.close(); }
  }
  if (!['resend','brevo'].includes(settings.provider) || !settings.api_key) throw error('MAIL_NOT_CONFIGURED',503);
  const resend = settings.provider === 'resend';
  const url = resend ? 'https://api.resend.com/emails' : 'https://api.brevo.com/v3/smtp/email';
  const headers = resend ? {Authorization:'Bearer ' + settings.api_key,'Idempotency-Key':scope + '/' + id} : {'api-key':settings.api_key};
  const body = resend
    ? {from:'MENTÁL.hu <' + settings.from_email + '>',to:[to],subject,text,...(html ? {html} : {}),...(replyTo ? {reply_to:replyTo} : {})}
    : {sender:{name:'MENTÁL.hu',email:settings.from_email},to:[{email:to}],subject,textContent:text,...(html ? {htmlContent:html} : {}),...(replyTo ? {replyTo:{name:replyToName || '',email:replyTo}} : {})};
  let response;
  try { response = await fetchImpl(url,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)}); }
  catch { throw error('MAIL_RESULT_UNCERTAIN'); }
  if (!response.ok) throw error('MAIL_HTTP_' + response.status);
  let result;
  try { result = await response.json(); } catch { throw error('MAIL_RESULT_UNCERTAIN'); }
  const acceptedId=result?.id || result?.messageId;
  if(typeof acceptedId!=='string'||!acceptedId.trim())throw error('MAIL_RESULT_UNCERTAIN');
  return {id:acceptedId.slice(0,250)};
}

module.exports = {sendMailMessage, validEmail};
