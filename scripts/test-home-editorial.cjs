'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {renderHomeFeatured,renderHomeArticles,renderHomeMoreArticles}=require('../lib/article-views.cjs');
const root=path.resolve(__dirname,'..');
const articles=Array.from({length:40},(_,i)=>({
 slug:'article-'+i,title:'Cikk '+i,category:'Kutatások',
 excerpt:'Kivonat '+i,reading_minutes:3,
 hero_url:'/assets/mental-research-43062354-hero.jpg',
 hero_image_alt:'Tesztfotó'
}));
const articleLinks=markup=>[...new Set([...markup.matchAll(/\bhref="(\/cikk\/[^"]+)"/g)].map(match=>match[1]))];
const expectedLinks=(first,last)=>Array.from({length:last-first},(_,i)=>'/cikk/article-'+(first+i));
const gridCards=markup=>(markup.match(/<article\b[^>]*class="[^"]*\barticle-card\b[^"]*"/g)||[]).length;
test('featured section contains exactly the newest five articles',()=>{
 const html=renderHomeFeatured(articles);
 assert.deepEqual(articleLinks(html),expectedLinks(0,5));
 assert.match(html,/story-lead/);
 assert.equal((html.match(/story-compact/g)||[]).length,4);
});
test('first grid contains fifteen articles after the featured five',()=>{
 const html=renderHomeArticles(articles);
 assert.match(html,/id="cikkek"/);
 assert.deepEqual(articleLinks(html),expectedLinks(5,20));
 assert.equal(gridCards(html),15);
});
test('continuation contains the next fifteen and all three blocks stay distinct and ordered',()=>{
 const html=renderHomeMoreArticles(articles);
 assert.match(html,/id="tovabbi-cikkek"/);
 assert.deepEqual(articleLinks(html),expectedLinks(20,35));
 assert.equal(gridCards(html),15);
 const combined=[...articleLinks(renderHomeFeatured(articles)),...articleLinks(renderHomeArticles(articles)),...articleLinks(html)];
 assert.equal(new Set(combined).size,35);
 assert.deepEqual(combined,expectedLinks(0,35));
});
test('short catalogues render only available articles without repeating or inventing cards',()=>{
 for(const [size,featured,first,continued] of [[0,0,0,0],[3,3,0,0],[5,5,0,0],[6,5,1,0],[19,5,14,0],[20,5,15,0],[21,5,15,1],[34,5,15,14]]){
  const items=articles.slice(0,size);
  const blocks=[renderHomeFeatured(items),renderHomeArticles(items),renderHomeMoreArticles(items)];
  const links=blocks.map(articleLinks);
  assert.deepEqual(links.map(list=>list.length),[featured,first,continued],'available records: '+size);
  assert.deepEqual(links.flat(),expectedLinks(0,size),'record order and uniqueness: '+size);
  assert.equal(gridCards(blocks[1]),first);
  assert.equal(gridCards(blocks[2]),continued);
  for(const block of blocks)assert.doesNotMatch(block,/href="\/cikk\/(?:undefined|null|)"/);
 }
});
test('static home template places the continuation after the pause and before categories',()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const featured=html.indexOf('<!-- home-featured:start -->');
 const search=html.search(/<form\b[^>]*action="\/kereses"/);
 const resources=html.indexOf('id="tudastar"');
 const lower=html.indexOf('<!-- home-articles:start -->');
 const pause=html.indexOf('id="pause-title"');
 const continued=html.indexOf('<!-- home-more-articles:start -->');
 const continuedEnd=html.indexOf('<!-- home-more-articles:end -->');
 const categories=html.indexOf('id="kategoriak"');
 assert.ok(featured>0 && search>featured,'featured articles must be before home search');
 assert.ok(lower>search,'remaining articles must follow expert search');
 assert.ok(pause>lower && continued>pause,'the continuation must follow the existing pause block');
 assert.ok(continuedEnd>continued && categories>continuedEnd && resources>categories,'categories and knowledge follow both article grids');
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
