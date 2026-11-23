'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {renderHomeFeatured,renderHomeArticles}=require('../lib/article-views.cjs');
const root=path.resolve(__dirname,'..');
const articles=Array.from({length:6},(_,i)=>({
 slug:'article-'+i,title:'Cikk '+i,category:'Kutatások',
 excerpt:'Kivonat '+i,reading_minutes:3,
 hero_url:'/assets/mental-research-43062354-hero.jpg',
 hero_image_alt:'Tesztfotó'
}));
test('featured section contains exactly the newest three articles',()=>{
 const html=renderHomeFeatured(articles);
 assert.match(html,/article-0/);
 assert.match(html,/article-1/);
 assert.match(html,/article-2/);
 assert.doesNotMatch(html,/article-3/);
 assert.match(html,/story-lead/);
 assert.equal((html.match(/story-compact/g)||[]).length,2);
});
test('lower list contains all articles after the featured three, without repeats',()=>{
 const html=renderHomeArticles(articles);
 assert.doesNotMatch(html,/article-[012]/);
 for(const id of [3,4,5]) assert.match(html,new RegExp('article-'+id));
});
test('static home template puts featured articles before search, remaining after Tudástár',()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const featured=html.indexOf('<!-- home-featured:start -->');
 const search=html.indexOf('id="searchForm"');
 const resources=html.indexOf('id="tudastar"');
 const lower=html.indexOf('<!-- home-articles:start -->');
 assert.ok(featured>0 && search>featured,'featured articles must be before home search');
 assert.ok(resources>search && lower>resources,'remaining articles must follow Tudástár');
 assert.match(html,/href="\/cikkek"[^>]*>[\s\S]*?Cikkek és kutatási hírek/);
});
