'use strict';

// Categories are editorial directory matches, not clinical recommendations.
// Each tier is shuffled independently; specific matches take precedence.
const PSYCHOLOGY = ['pszichologusok', 'pszichoterapeutak'];
const CLINICAL = ['pszichiaterek', ...PSYCHOLOGY];
const CHILD = 'gyerm|gyerek|serdül|serdul|kamasz|ifjús|ifjus';
const ADHD = 'adhd|figyelemhi|hiperakt';
const OLDER = 'idős|idos|geriátr|geriatr|demencia|alzheimer|memória|memoria';
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const tier = (slugs, patterns = []) => ({ slugs, patterns });
const TOPIC_TIERS = {
  'pszichologia': [tier(PSYCHOLOGY)],
  'mentalis egeszseg': [tier(CLINICAL), tier(['mentalhigienes-szakemberek'])],
  'mentalhigiene': [tier(['mentalhigienes-szakemberek']), tier(PSYCHOLOGY)],
  'depresszio': [tier(CLINICAL, ['depressz']), tier(CLINICAL)],
  'szorongas': [tier(PSYCHOLOGY, ['szorong|pánik|panik']), tier(CLINICAL)],
  'bipolaris zavar': [tier(['pszichiaterek'], ['bipolár|bipolar']), tier(['pszichiaterek']), tier(['pszichoterapeutak'])],
  'fuggosegek': [tier(CLINICAL, ['függős|fuggos|addikt|szenvedély|szenvedely']), tier(['pszichiaterek', 'pszichoterapeutak'])],
  'trauma es krizis': [tier(PSYCHOLOGY, ['trauma|krízis|krizis|gyász|gyasz']), tier(CLINICAL)],
  'terapia es ellatas': [tier(['pszichoterapeutak', 'pszichiaterek']), tier(['pszichologusok'])],
  'alvas': [tier(['alvas-es-relaxacio']), tier(PSYCHOLOGY, ['alvás|alvas|inszom|álmatlan|almatlan']), tier(PSYCHOLOGY)],
  'kapcsolatok': [tier(['par-es-csaladterapeutak']), tier(PSYCHOLOGY)],
  'csalad': [tier(['par-es-csaladterapeutak']), tier(PSYCHOLOGY, [CHILD]), tier(PSYCHOLOGY)],
  'onismeret': [tier(['pszichologusok', 'mentalhigienes-szakemberek']), tier(['pszichoterapeutak'])],
  'munka': [tier(['pszichologusok', 'mentalhigienes-szakemberek'], ['munka|kiég|kieg|stressz|karrier']), tier(['karrier-tanacsadok']), tier(['pszichologusok'])],
  'munka es kieges': [tier(PSYCHOLOGY, ['kiég|kieg|munka|stressz']), tier(['mentalhigienes-szakemberek', 'pszichologusok'])],
  'digitalis elet': [tier(PSYCHOLOGY, ['digitális|digitalis|internet|online függ|online fugg|képernyő|kepernyo']), tier(PSYCHOLOGY)],
  'test es lelek': [tier(PSYCHOLOGY), tier(['mentalhigienes-szakemberek'])],
  'jollet': [tier(['mentalhigienes-szakemberek', 'pszichologusok'])],
  'erzelmek es viselkedes': [tier(PSYCHOLOGY)],
  'kerdes–valasz': [tier(['pszichologusok', 'mentalhigienes-szakemberek'])],
  'kerdes es valasz': [tier(['pszichologusok', 'mentalhigienes-szakemberek'])]
};

function providerSelection(article = {}) {
  const topic = normalize(article.category).trim();
  const context = normalize([article.title, article.excerpt].filter(Boolean).join(' '));
  // A retrospective study in adults must not send readers to child-only services.
  const child = topic === 'gyermekek es serdulok'
    || (!/felnott/.test(context) && /gyermek|gyerek|serdul|kamasz|iskolas/.test(context));
  const adult = !child && (/felnott/.test(context) || topic === 'adhd' || /\badhd\b/.test(context));
  let tiers;
  if (topic === 'adhd' || /\badhd\b/.test(context)) {
    tiers = child
      ? [tier(CLINICAL, [ADHD, CHILD]), tier(['gyermekkori-diagnosztika']), tier(CLINICAL, [CHILD])]
      : [tier(CLINICAL, [ADHD]), tier(['pszichiaterek', 'pszichoterapeutak']), tier(['pszichologusok'])];
  } else if (/demencia|alzheimer|memoriazavar|kognitiv romlas/.test(context) || topic === 'demencia') {
    tiers = [tier(['demencia']), tier(['neurologia'], [OLDER]), tier(CLINICAL, [OLDER])];
  } else if (topic === 'idoskori mentalis egeszseg') {
    tiers = [tier([...CLINICAL, 'mentalhigienes-szakemberek'], [OLDER]), tier(['pszichiaterek', 'pszichologusok'])];
  } else if (child) {
    tiers = [tier(CLINICAL, [CHILD]), tier(['par-es-csaladterapeutak'])];
    if (/diagnosz|kivizsgal|fejlodesi zavar|autiz/.test(context)) tiers.unshift(tier(['gyermekkori-diagnosztika']));
  } else {
    tiers = TOPIC_TIERS[topic] || [tier(['pszichologusok', 'mentalhigienes-szakemberek'])];
  }
  return tiers.map((group, priority) => ({ ...group, priority, adult }));
}

const SELECT_PROVIDERS = `
  SELECT l.id,l.slug,l.name,l.city,l.online_available,
         matched.slug AS category_slug,matched.name AS category_name
  FROM directory_listings l
  CROSS JOIN LATERAL (
    SELECT c.slug,c.name,r.priority
    FROM directory_listing_categories lc
    JOIN directory_categories c ON c.id=lc.category_id
    JOIN jsonb_to_recordset($1::jsonb) AS r(slugs jsonb,patterns jsonb,priority integer,adult boolean)
      ON r.slugs ? c.slug
    WHERE lc.listing_id=l.id AND c.active=true
      AND c.verification_level<>'alternative'
      AND (NOT r.adult
        OR concat_ws(' ',l.name,l.short_description,l.specialties) !~* '${CHILD}'
        OR concat_ws(' ',l.name,l.short_description,l.specialties) ~* 'felnőtt|felnott')
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(r.patterns) AS pattern(value)
        WHERE concat_ws(' ',l.name,l.short_description,l.specialties) !~* pattern.value
      )
    ORDER BY r.priority,c.sort_order,c.id
    LIMIT 1
  ) AS matched
  WHERE l.status='published' AND l.kind IN ('provider','organization')
    AND (l.published_at IS NULL OR l.published_at<=now())
  ORDER BY matched.priority,random()
  LIMIT $2`;

async function selectRelatedProviders(pool, article, limit = 4) {
  const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 4) : 4;
  const { rows } = await pool.query({
    text: SELECT_PROVIDERS,
    values: [JSON.stringify(providerSelection(article)), count],
    query_timeout: 1500
  });
  return rows.map(row => ({ ...row, url: '/szolgaltato/' + encodeURIComponent(row.slug) }));
}

module.exports = { providerSelection, selectRelatedProviders };
