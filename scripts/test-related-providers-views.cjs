'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {renderArticle, renderRelatedProviders, editorialShell} = require('../lib/article-views.cjs');

const article = {slug:'szorongas-a-hetkoznapokban',title:'Szorongás a hétköznapokban',category:'Szorongás',content_html:'<p>Az olvasható cikk.</p>',sources:[]};
const provider = {slug:'pelda-szakember',name:'Példa Szakember',city:'Debrecen',category_name:'Pszichológusok',online_available:true};

test('article location controls show a coarse city and never render coordinates or IP addresses', () => {
  const markup = renderArticle(article, {providerLocation:{id:'budapest',name:'Budapest',source:'ip',latitude:47.498401,longitude:19.040401,ip:'8.8.8.8'},providers:[{...provider,match_type:'online'}]});
  assert(markup.includes('data-article-slug="szorongas-a-hetkoznapokban"'));
  assert(markup.includes('data-provider-city-id="budapest"'));
  assert(markup.includes('data-provider-city-source="ip"'));
  assert(markup.includes('Becsült hely'));
  assert(markup.includes('Helyzetem használata'));
  assert(markup.includes('data-provider-location-controls hidden'));
  assert(markup.includes('data-provider-reset-location hidden'));
  for (const sensitive of ['47.498401', '19.040401', '8.8.8.8']) assert(!markup.includes(sensitive));
  assert(markup.includes('https://www.geonames.org/'));
  assert(markup.includes('https://db-ip.com/'));
});

test('online fallback is explicit, nearby distances are approximate, and legacy renderer remains compatible', () => {
  const online = renderRelatedProviders([{...provider,match_type:'online'}]);
  assert(online.includes('Online konzultáció'));
  assert(!online.includes('Online is'));
  assert(online.includes('Debrecen'));
  const nearby = renderRelatedProviders([{...provider,city:'Budaörs',match_type:'nearby',distance_km:8.4}]);
  assert(nearby.includes('Budaörs · kb. 8 km · Online is'));
  assert(nearby.includes('Településközpontok közötti becsült távolság'));
  assert(!nearby.includes('Online konzultáció'));
  assert(renderRelatedProviders([provider]).includes('Online is'));
});

test('unknown location invites a city choice and optional data failures leave article content available', () => {
  const markup = renderArticle(article, {providers:null});
  assert(markup.includes('Válassz települést'));
  assert(markup.includes('Addig online szakembereket mutatunk.'));
  assert(markup.includes('Böngéssz a katalógusban'));
  assert(markup.includes('Az olvasható cikk.'));
  assert(markup.includes('aria-label="Település keresése"'));
  assert(markup.includes('for="provider-city-query"'));
  assert(markup.includes('aria-controls="provider-city-results"'));
  assert(markup.includes('href="/szolgaltatok"'));
});

test('location metadata is escaped and article-specific assets do not load in the archive shell', () => {
  const markup = renderArticle(article, {providerLocation:{id:'\"><script>bad()</script>',name:'<img src=x onerror=bad()>',source:'manual'}});
  assert(!markup.includes('<script>bad()'));
  assert(!markup.includes('<img src=x onerror'));
  assert(markup.includes('&lt;img src=x onerror=bad()&gt;'));
  assert(markup.includes('data-provider-reset-location>Automatikus hely'));
  assert(markup.includes('/related-providers.js?v=geo-20261127'));
  assert(markup.includes('/related-providers.css?v=geo-20261127'));
  assert(!editorialShell('Cikkek', '<main>Cikkek</main>').includes('/related-providers.'));
});
