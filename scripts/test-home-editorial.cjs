'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {renderHomeFeatured,renderHomeArticles}=require('../lib/article-views.cjs');
const root=path.resolve(__dirname,'..');
const articles=Array.from({length:16},(_,i)=>({
 slug:'article-'+i,title:'Cikk '+i,category:'Kutatások',
 excerpt:'Kivonat '+i,reading_minutes:3,
 hero_url:'/assets/mental-research-43062354-hero.jpg',
 hero_image_alt:'Tesztfotó'
}));
test('featured section contains exactly the newest five articles',()=>{
 const html=renderHomeFeatured(articles);
 assert.match(html,/article-0/);
 assert.match(html,/article-1/);
 assert.match(html,/article-2/);
 assert.match(html,/article-3/);
 assert.match(html,/article-4/);
 assert.doesNotMatch(html,/article-5/);
 assert.match(html,/story-lead/);
 assert.equal((html.match(/story-compact/g)||[]).length,4);
});
test('lower list contains nine articles after the featured five, without repeats',()=>{
 const html=renderHomeArticles(articles);
 for(const id of [0,1,2,3,4,14,15]) assert.ok(!html.includes('href="/cikk/article-'+id+'"'));
 for(let id=5;id<14;id++) assert.ok(html.includes('href="/cikk/article-'+id+'"'));
 assert.equal((html.match(/<article\b[^>]*class="[^"]*\barticle-card\b[^"]*"/g)||[]).length,9);
});
test('static home template follows the approved cover, search, articles, categories and knowledge order',()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const featured=html.indexOf('<!-- home-featured:start -->');
 const search=html.search(/<form\b[^>]*action="\/kereses"/);
 const resources=html.indexOf('id="tudastar"');
 const lower=html.indexOf('<!-- home-articles:start -->');
 const categories=html.indexOf('id="kategoriak"');
 assert.ok(featured>0 && search>featured,'featured articles must be before home search');
 assert.ok(lower>search,'remaining articles must follow expert search');
 assert.ok(categories>lower && resources>categories,'categories and knowledge follow the article grid');
 assert.match(html,/href="\/cikkek"/);
 assert.doesNotMatch(html,/<section\b[^>]*class="[^"]*\bmasthead\b/,'the removed masthead must not return');
});

test('article page has no redundant MENTÁL.hu AI colophon',()=>{
 const {renderArticle}=require('../lib/article-views.cjs');
 const rendered=renderArticle({...articles[0],publication_origin:'research-watch',sources:[]});
 assert.doesNotMatch(rendered,/Ismeretterjesztő írás, mesterséges intelligencia közreműködésével/);
 assert.doesNotMatch(rendered,/A személyes helyzeted megítélésében megfelelő szakember segíthet/);
 assert.doesNotMatch(rendered,/reader-colophon/);
});
