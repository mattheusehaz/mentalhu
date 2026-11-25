'use strict';

const curatedTopics = require('../content/article-topics.json');
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const genericCategories = new Set(['', 'kutatas', 'kutatasok', 'research']);

// Existing articles use reviewed editorial assignments. These fallback rules
// only help future imports that still arrive with the old generic category.
// A concrete category chosen by an editor always takes precedence.
const topicRules = [
  ['ADHD', /\badhd\b|figyelemhiany|hiperaktiv/],
  ['Bipoláris zavar', /bipolar|hipomania|hipomanias/],
  ['Trauma és krízis', /\bptsd\b|poszttrauma|trauma|ongyilk|onsert|krizis/],
  ['Függőségek', /\bfuggoseg|szerhasznalat|alkohol|dohany|nikotin|szerencsejatek/],
  ['Alvás', /alvas|almatlan|inszomnia|cirkadian/],
  ['Depresszió', /depressz/],
  ['Szorongás', /szorong|panik|fobia|fobias|kenyszerbeteg|\bocd\b|kiberhondria/],
  ['Munka és kiégés', /kieges|munkahely|palyabizonytalansag|munkanelkul/],
  ['Időskori mentális egészség', /idoskor|\bidos(?:ek|kori|koru)|demencia|alzheimer|kognitiv romlas/],
  ['Terápia és ellátás', /pszichoterap|terapia|terapias|pszichiatriai ellatas|szakellatas|ellatorendszer|segitsegkeres|lelki segitseg|mentalhigienes program/],
  ['Digitális élet', /kozossegi media|kozossegi oldal|okostelefon|kepernyo|chatbot|mesterseges intelligencia|internethasznalat|internet.*bizalom|digitalis elet/],
  ['Család', /szuloi konfliktus|csaladi konfliktus|csaladi kapcsolat|anyasag|apasag|varandossag/],
  ['Gyermekek és serdülők', /gyermek|gyerek|serdul|kamasz|iskolai|tanuloi/],
  ['Kapcsolatok', /parkapcsol|kotodes|magany|baratsag|tarsas tamogat|tarsas kapcsolat|tarskeres/],
  ['Önismeret', /onismer|onegyutterzes|onertekeles|onbizalom|perfekcion|mindfulness|meditacio/],
  ['Érzelmek és viselkedés', /erzelem|erzelm|viselkedes|szuggeszt|kleptomania/],
  ['Test és lélek', /testkep|testmozgas|fizikai aktivitas|sport|edzes|taplalkoz|etrend|valtozokor|menopauza|fajdalom|daganatos|genetikai|mikrobiom/],
  ['Jóllét', /jollet|boldogsag|szabadido|stressz|megkuzdes|lelki egeszseg/]
];

function resolveArticleTopic(article = {}) {
  const category = typeof article.category === 'string' ? article.category.trim() : '';
  if (!genericCategories.has(normalize(category))) return category;
  if (Object.hasOwn(curatedTopics, article.slug || '')) return curatedTopics[article.slug];
  for (const value of [article.title, article.excerpt]) {
    const match = topicRules.find(([, pattern]) => pattern.test(normalize(value)));
    if (match) return match[0];
  }
  return 'Mentális egészség';
}

async function backfillArticleTopics({ pool, logger = console }) {
  const { rows } = await pool.query(`SELECT id,slug,title,category,excerpt FROM articles
    WHERE lower(btrim(category)) IN ('kutatások','kutatasok','kutatás','kutatas','research','')`);
  const assignments = rows.map(article => ({
    id: article.id, previous_category: article.category, category: resolveArticleTopic(article)
  }));
  if (!assignments.length) return { updated: 0 };

  // Conditional updates preserve concurrent editorial changes. The update and
  // its audit entry are atomic; publication status, publication time and text stay put.
  const result = await pool.query(`WITH changed AS (
    UPDATE articles AS a SET category=t.category,updated_at=now()
    FROM jsonb_to_recordset($1::jsonb) AS t(id bigint,previous_category text,category text)
    WHERE a.id=t.id AND a.category=t.previous_category
    RETURNING a.id,a.slug,a.category,t.previous_category
  )
  INSERT INTO cms_audit_log(action,entity_type,entity_id,actor_email,details)
  SELECT 'update_article_topic','article',id::text,NULL,
    jsonb_build_object('slug',slug,'from',previous_category,'to',category,
      'reason','owner-requested-topic-labels','policy','article-topics-20261125')
  FROM changed RETURNING entity_id`, [JSON.stringify(assignments)]);
  const updated = result.rowCount;
  if (updated) logger.info?.('[article-topics] assigned:', updated);
  return { updated };
}

module.exports = { resolveArticleTopic, backfillArticleTopics };
