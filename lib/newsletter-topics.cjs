'use strict';

const { resolveArticleTopic } = require('./article-topics.cjs');

// Stable public identifiers are deliberately separate from the provider directory.
// Aliases retain older editorial labels without giving subscribers duplicate choices.
const definitions = [
  ['all', 'Minden téma', []],
  ['mentalis-egeszseg', 'Mentális egészség', ['Mentális egészség']],
  ['pszichologia', 'Pszichológia', ['Pszichológia']],
  ['mentalhigiene', 'Mentálhigiéné', ['Mentálhigiéné']],
  ['adhd', 'ADHD', ['ADHD']],
  ['alvas', 'Alvás', ['Alvás']],
  ['bipolaris-zavar', 'Bipoláris zavar', ['Bipoláris zavar']],
  ['csalad', 'Család', ['Család']],
  ['depresszio', 'Depresszió', ['Depresszió']],
  ['digitalis-elet', 'Digitális élet', ['Digitális élet']],
  ['fuggosegek', 'Függőségek', ['Függőségek']],
  ['gyermekek-es-serdulok', 'Gyermekek és serdülők', ['Gyermekek és serdülők']],
  ['idoskori-mentalis-egeszseg', 'Időskori mentális egészség', ['Időskori mentális egészség']],
  ['jollet', 'Jóllét', ['Jóllét']],
  ['kapcsolatok', 'Kapcsolatok', ['Kapcsolatok']],
  ['kerdes-valasz', 'Kérdés–válasz', ['Kérdés–válasz', 'Kérdés-válasz', 'Kérdés és válasz']],
  ['munka-es-kieges', 'Munka és kiégés', ['Munka', 'Munka és kiégés']],
  ['onismeret', 'Önismeret', ['Önismeret']],
  ['szorongas', 'Szorongás', ['Szorongás']],
  ['terapia-es-ellatas', 'Terápia és ellátás', ['Terápia és ellátás']],
  ['test-es-lelek', 'Test és lélek', ['Test és lélek']],
  ['trauma-es-krizis', 'Trauma és krízis', ['Trauma és krízis']],
  ['erzelmek-es-viselkedes', 'Érzelmek és viselkedés', ['Érzelmek és viselkedés']]
];
const NEWSLETTER_TOPICS = Object.freeze(definitions.map(([key, label]) => Object.freeze({ key, label })));
const keys = new Set(NEWSLETTER_TOPICS.map(item => item.key));
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[–—-]/g, ' ').replace(/\s+/g, ' ').trim();
const categoryKeys = new Map(definitions.flatMap(([key, , aliases]) => aliases.map(alias => [normalize(alias), key])));

function normalizeTopics(value) {
  if (!Array.isArray(value) || !value.length || value.length > NEWSLETTER_TOPICS.length || value.some(key => typeof key !== 'string' || !keys.has(key))) {
    throw Object.assign(new Error('INVALID_TOPICS'), { code: 'INVALID_TOPICS', httpStatus: 400 });
  }
  if (value.includes('all')) return ['all'];
  const selected = new Set(value);
  return NEWSLETTER_TOPICS.filter(item => selected.has(item.key)).map(item => item.key);
}

function topicLabels(topics) {
  const selected = new Set(topics || []);
  return NEWSLETTER_TOPICS.filter(item => selected.has(item.key)).map(item => item.label);
}

function articleTopicKey(article) {
  return categoryKeys.get(normalize(resolveArticleTopic(article))) || null;
}

function articleMatchesTopics(article, topics) {
  return Array.isArray(topics) && (topics.includes('all') || topics.includes(articleTopicKey(article)));
}

module.exports = { NEWSLETTER_TOPICS, normalizeTopics, topicLabels, articleTopicKey, articleMatchesTopics };
