'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {ratingScore}=require('../lib/provider-ratings.cjs');

test('provider ratings accept only integer scores from one through five',()=>{
  for(const score of [1,2,3,4,5])assert.equal(ratingScore({score}),score);
  for(const body of [null,undefined,[],[5],5,'5',{}, {score:0},{score:6},{score:-1},{score:2.5},{score:'5'},{score:true},{score:NaN},{score:Infinity}]){
    assert.throws(()=>ratingScore(body),{code:'INVALID_RATING',httpStatus:400});
  }
});

test('rating input cannot provide an author, target, moderation state or unexpected content',()=>{
  for(const field of ['account_id','author_id','reader_id','listing_id','provider_id','status','approved','comment','email','__proto__']){
    const body=JSON.parse('{"score":5,"'+field+'":"unexpected"}');
    assert.throws(()=>ratingScore(body),{code:'INVALID_RATING'},field);
  }
});
