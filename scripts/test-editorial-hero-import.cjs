'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateAssignment,importApprovedHeroAssignments}=require('../lib/editorial-hero-import.cjs');
const example={external_id:'mental-research-43062354',article_revision:'a'.repeat(64),image_path:'/assets/mental-research-43062354-hero.jpg',image_sha256:'b'.repeat(64),alt_text:'Kép',approval_reference:'chat-message:explicit-approval'};
test('assignment requires immutable article/image revision and approval reference',()=>{
 assert.equal(validateAssignment({...example}).image_path,example.image_path);
 for(const changes of [{article_revision:'abc'},{image_path:'/assets/other.jpg'},{image_path:'/assets/../file.jpg'},{approval_reference:'none'},{image_sha256:'wrong'}]){
  assert.throws(()=>validateAssignment({...example,...changes}));
 }
});
test('missing manifest does not modify the database',async()=>{
 const pool={connect(){throw new Error('should not connect');}};
 const r=await importApprovedHeroAssignments({pool,root:'/nonexistent-path-for-test'});
 assert.deepEqual(r,{updated:0,skipped:0,errors:[]});
});
