'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {submissionId,listFilters,listWhere,approvalMessage}=require('../lib/directory-submissions.cjs');

test('submission identifiers preserve bigint IDs and reject malformed or oversized values',()=>{
  assert.equal(submissionId('9223372036854775807'),'9223372036854775807');
  for(const value of ['0','01','-1','1 OR 1=1','1.5','9223372036854775808',1,null,undefined])assert.throws(()=>submissionId(value),{code:'INVALID_ID'});
});
test('submission filters bound pagination and keep search text out of SQL',()=>{
  const filters=listFilters({q:"%' OR 1=1 --",trash:'true',paginated:'true',status:'accepted',page:'999999999999999999',page_size:'5000'});
  assert.equal(filters.page,1);assert.equal(filters.pageSize,100);assert.equal(filters.trash,true);assert.equal(filters.paginated,true);
  const where=listWhere(filters);assert.equal(where.params[0],'accepted');assert.equal(where.params[1],"%\\%' OR 1=1 --%");
  assert(!where.clause.includes('OR 1=1'));assert(where.clause.includes('s.deleted_at IS NOT NULL'));
  assert.throws(()=>listFilters({status:'deleted'}),{code:'INVALID_STATUS'});
  assert.equal(listFilters({q:{bad:true}}).q,'');
});
test('approval acknowledgements do not claim email delivery before a send',()=>{
  assert.match(approvalMessage('needs_mail'),/még nem küldtünk e-mailt/);
  assert.match(approvalMessage('queued'),/küldésre vár/);
  assert.match(approvalMessage('accepted'),/levélküldő átvette/);
  assert.match(approvalMessage('failed'),/sikertelen/);
  assert.match(approvalMessage('uncertain'),/bizonytalan/);
  assert(!/kézbesítettük|megérkezett/.test(approvalMessage('accepted')));
});
