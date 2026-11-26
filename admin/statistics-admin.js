(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const number = value => new Intl.NumberFormat('hu-HU').format(Math.max(0, Number(value) || 0));
  const isCount = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isFinite(Number(value)) && Number(value) >= 0;
  const timezone = 'Europe/Budapest';
  const tables = {
    articles: {page:1,pages:1,request:0,controller:null,timer:null},
    listings: {page:1,pages:1,request:0,controller:null,timer:null}
  };
  let authenticated = false, summaryRequest = 0, refreshRequest = 0, summaryController = null;
  const statusLabels = {published:'Publikált',draft:'Piszkozat',pending:'Ellenőrzésre vár',rejected:'Elutasított',deleted:'Törölt tartalom',archived:'Archivált'};

  function date(value, options = {}) {
    if (!value) return '–';
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T12:00:00Z' : value);
    return Number.isNaN(parsed.valueOf()) ? '–' : new Intl.DateTimeFormat('hu-HU', {timeZone:timezone,month:'short',day:'numeric',...options}).format(parsed);
  }
  function dayKey(value) {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf())) return '';
    const parts = new Intl.DateTimeFormat('en', {timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(parsed);
    const part = type => parts.find(item => item.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  function rangeLabel(period) {
    if (!period?.start) return period?.label || '–';
    const end = period.end ? new Date(new Date(period.end).valueOf() - 1) : null;
    return date(period.start, {year:'numeric'}) + (end && !Number.isNaN(end.valueOf()) && dayKey(period.start) !== dayKey(end.toISOString()) ? ' – ' + date(end.toISOString()) : '');
  }
  function requireLogin() {
    authenticated = false;
    byId('statisticsLogin').hidden = false;
    byId('statisticsBody').hidden = true;
    byId('statisticsMessage').textContent = '';
    byId('refreshStatistics').disabled = false;
  }
  async function api(path, signal) {
    const response = await fetch(path, {credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)});
    if (response.status === 401 || response.status === 403) {
      requireLogin();
      const error = new Error('Adminisztrátori bejelentkezés szükséges.'); error.unauthorized = true; throw error;
    }
    if (!response.ok) throw new Error('Az adatok most nem tölthetők be. Kérjük, próbáld újra a frissítést.');
    return response.json();
  }
  function renderTrend(data) {
    const started = dayKey(data.measurement_started_at);
    const startedAt = new Date(data.measurement_started_at);
    const startTime = Number.isNaN(startedAt.valueOf()) ? '' : new Intl.DateTimeFormat('hu-HU', {timeZone:timezone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(startedAt);
    const partialFirstDay = Boolean(startTime && startTime !== '00:00:00');
    const rows = Array.isArray(data.trend) ? data.trend.slice(-14) : [];
    const maximum = Math.max(1, ...rows.filter(row => !started || dayKey(row.date) >= started).map(row => Number(row.visitors) || 0));
    byId('statisticsTrend').innerHTML = rows.map(row => {
      const measured = !started || dayKey(row.date) >= started;
      const visitors = Math.max(0, Number(row.visitors) || 0);
      const height = measured && visitors ? Math.max(2, Math.round(visitors / maximum * 100)) : 0;
      const partial = measured && partialFirstDay && dayKey(row.date) === started ? '. Részleges nap: a mérés ' + startTime + '-kor indult.' : '';
      const label = date(row.date, {year:'numeric'}) + ': ' + (measured ? number(visitors) + ' becsült látogató, ' + number(row.views) + ' oldalmegtekintés, ' + number(row.contacts) + ' kapcsolatfelvétel' + partial : 'a látogatottságmérés még nem indult el');
      return '<li' + (measured ? '' : ' class="unmeasured"') + ' aria-label="' + esc(label) + '" title="' + esc(label) + '"><span class="stats-trend-value" aria-hidden="true">' + (measured ? number(visitors) : '–') + '</span><span class="stats-trend-well" aria-hidden="true"><span class="stats-trend-bar" style="height:' + height + '%"></span></span><span class="stats-trend-date" aria-hidden="true">' + esc(date(row.date, {month:'2-digit',day:'2-digit'})) + '</span></li>';
    }).join('');
    byId('trendCaption').textContent = rows.length ? 'A vonalkázott napokra még nincs látogatottsági mérés.' + (partialFirstDay ? ' A mérés első napja csak a kezdés időpontjától tartalmaz adatokat.' : '') + ' A napi értékeket külön számoljuk; összegük eltérhet a heti egyedi látogatószámtól.' : 'Még nincs megjeleníthető napi látogatottsági adat.';
  }
  function renderSummary(data) {
    if (!data?.today || !data?.week || !data?.totals || !data?.period || !data.measurement_started_at || Number.isNaN(new Date(data.measurement_started_at).valueOf())) throw new Error('A statisztikák válasza hiányos. Próbáld újra a frissítést.');
    for (const key of ['today','week']) if (!['visitors','views','contacts'].every(field => isCount(data[key][field]))) throw new Error('A látogatottsági összesítés hiányos.');
    if (!['views','article_views','listing_views','contacts'].every(field => isCount(data.totals[field]))) throw new Error('Az időszak összesítése hiányos.');
    for (const key of ['today','week']) {
      byId(key + 'Visitors').textContent = number(data[key].visitors);
      byId(key + 'Views').textContent = number(data[key].views);
      byId(key + 'Contacts').textContent = number(data[key].contacts);
    }
    byId('todayDate').textContent = date(data.today.start, {year:'numeric'});
    byId('weekDate').textContent = rangeLabel(data.week);
    for (const [id,key] of [['periodViews','views'],['periodArticleViews','article_views'],['periodListingViews','listing_views'],['periodContacts','contacts']]) byId(id).textContent = number(data.totals[key]);
    byId('statisticsPeriod').textContent = data.period.label ? data.period.label + ' · ' + rangeLabel(data.period) : rangeLabel(data.period);
    byId('statisticsStarted').textContent = 'A látogatottságmérés kezdete: ' + date(data.measurement_started_at, {year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}) + '. Az ezt megelőző látogatottság nem áll rendelkezésre.';
    byId('statisticsUpdated').textContent = 'Utolsó frissítés: ' + date(data.generated_at || new Date().toISOString(), {year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}) + ' · Europe/Budapest';
    renderTrend(data);
  }
  async function loadSummary() {
    const request = ++summaryRequest;
    summaryController?.abort(); summaryController = new AbortController();
    const data = await api('/api/admin/statistics?' + new URLSearchParams({range:byId('statisticsRange').value}), summaryController.signal);
    if (request !== summaryRequest || !authenticated) return;
    renderSummary(data);
  }
  function rowTitle(item, type) {
    const title = type === 'articles' ? item.title : item.name;
    const expectedUrl = item.slug ? (type === 'articles' ? '/cikk/' : '/szolgaltato/') + encodeURIComponent(item.slug) : '';
    const url = expectedUrl && item.status === 'published' && item.url === expectedUrl ? expectedUrl : '';
    const name = title || (type === 'articles' ? 'Törölt cikk' : 'Törölt adatlap');
    let markup = url ? '<a class="stats-title" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(name) + '<span class="stats-sr-only"> – megnyitás új lapon</span></a>' : '<span class="stats-title">' + esc(name) + '</span>';
    const city = type === 'listings' && item.city ? esc(item.city) : '';
    const stateLabel = item.status === 'published' && !url ? 'Még nem nyilvános' : item.status && item.status !== 'published' ? statusLabels[item.status] || item.status : '';
    const state = stateLabel ? '<span class="stats-row-status">' + esc(stateLabel) + '</span>' : '';
    if (city || state) markup += '<span class="stats-row-meta">' + city + state + '</span>';
    return markup;
  }
  function renderTable(type, result) {
    if (!Array.isArray(result?.items) || !Number.isFinite(Number(result.total))) throw new Error('A lista nem tölthető be. Próbáld újra a frissítést.');
    if (!result.items.every(item => isCount(item.views) && (type !== 'listings' || isCount(item.contacts)))) throw new Error('A lista mérési adatai hiányosak.');
    const state = tables[type]; state.page = Math.max(1, Number(result.page) || 1); state.pages = Math.max(1, Number(result.pages) || 1);
    byId(type + 'Count').textContent = number(result.total) + (type === 'articles' ? ' cikk' : ' adatlap') + ' · megtekintés szerint';
    byId(type + 'Table').innerHTML = result.items.length ? '<table class="stats-table"><thead><tr><th scope="col">' + (type === 'articles' ? 'Cikk címe' : 'Szolgáltató') + '</th><th scope="col" class="stats-number">Megtekintés</th>' + (type === 'listings' ? '<th scope="col" class="stats-number">Kapcsolatfelvétel</th>' : '') + '</tr></thead><tbody>' + result.items.map(item => '<tr><td>' + rowTitle(item, type) + '</td><td class="stats-number">' + number(item.views) + '</td>' + (type === 'listings' ? '<td class="stats-number">' + number(item.contacts) + '</td>' : '') + '</tr>').join('') + '</tbody></table>' : '<p class="stats-table-empty">' + (byId(type + 'Search').value.trim() ? 'Nincs a keresésnek megfelelő találat.' : type === 'articles' ? 'Még nincs megjeleníthető cikk.' : 'Még nincs megjeleníthető szolgáltatói adatlap.') + '</p>';
    byId(type + 'Page').textContent = state.page + ' / ' + state.pages + '. oldal';
    byId(type + 'Previous').disabled = state.page <= 1;
    byId(type + 'Next').disabled = state.page >= state.pages;
  }
  async function loadTable(type) {
    const state = tables[type], request = ++state.request;
    state.controller?.abort(); state.controller = new AbortController();
    const message = byId(type + 'Message'); message.classList.remove('error'); message.textContent = 'Betöltés…';
    byId(type + 'Table').setAttribute('aria-busy', 'true');
    byId(type + 'Previous').disabled = true; byId(type + 'Next').disabled = true;
    const params = new URLSearchParams({range:byId('statisticsRange').value,q:byId(type + 'Search').value.trim(),page:String(state.page),page_size:'25'});
    try {
      const result = await api('/api/admin/statistics/' + type + '?' + params, state.controller.signal);
      if (request !== state.request || !authenticated) return null;
      renderTable(type, result); message.textContent = ''; return true;
    } catch (error) {
      if (request !== state.request || error.name === 'AbortError' || error.unauthorized) return null;
      message.classList.add('error'); message.textContent = 'A lista most nem tölthető be. Az „Adatok frissítése” gombbal újrapróbálhatod.';
      byId(type + 'Table').innerHTML = '';
      byId(type + 'Count').textContent = 'A lista nem érhető el';
      byId(type + 'Page').textContent = '–';
      return false;
    } finally { if (request === state.request) byId(type + 'Table').setAttribute('aria-busy', 'false'); }
  }
  async function refresh() {
    if (!authenticated) return bootstrap();
    const request = ++refreshRequest;
    const message = byId('statisticsMessage'); message.classList.remove('error'); message.textContent = 'Adatok frissítése…';
    byId('refreshStatistics').disabled = true;
    const results = await Promise.allSettled([loadSummary(), loadTable('articles'), loadTable('listings')]);
    if (request !== refreshRequest || !authenticated) return;
    const summary = results[0];
    if (summary.status === 'rejected' && summary.reason.name !== 'AbortError') {
      message.classList.add('error'); message.textContent = 'Az összesítés most nem tölthető be. Próbáld újra az „Adatok frissítése” gombbal.';
      for (const id of ['todayVisitors','todayViews','todayContacts','weekVisitors','weekViews','weekContacts','periodViews','periodArticleViews','periodListingViews','periodContacts']) byId(id).textContent = '–';
      byId('statisticsTrend').innerHTML = '';
      byId('statisticsUpdated').textContent = '';
    } else if (results.slice(1).some(result => result.status === 'rejected' || result.value === false)) {
      message.classList.add('error'); message.textContent = 'Az összesítés frissült, de valamelyik lista nem tölthető be. Próbáld újra a frissítést.';
    } else message.textContent = '';
    byId('refreshStatistics').disabled = false;
  }
  async function bootstrap() {
    const message = byId('statisticsMessage'); message.classList.remove('error'); message.textContent = 'Statisztikák betöltése…';
    byId('refreshStatistics').disabled = true;
    try {
      await api('/api/admin/me'); authenticated = true;
      byId('statisticsLogin').hidden = true; byId('statisticsBody').hidden = false;
      await refresh();
    } catch (error) {
      if (!error.unauthorized) { message.classList.add('error'); message.textContent = 'A statisztikák most nem érhetők el. Próbáld újra az „Adatok frissítése” gombbal.'; }
    } finally { byId('refreshStatistics').disabled = false; }
  }
  byId('refreshStatistics').addEventListener('click', refresh);
  byId('statisticsRange').addEventListener('change', () => { for (const state of Object.values(tables)) { state.page = 1; clearTimeout(state.timer); } refresh(); });
  for (const [type,state] of Object.entries(tables)) {
    const search = () => { clearTimeout(state.timer); state.page = 1; loadTable(type); };
    byId(type + 'SearchForm').addEventListener('submit', event => { event.preventDefault(); search(); });
    byId(type + 'Search').addEventListener('input', () => { clearTimeout(state.timer); state.timer = setTimeout(search, 300); });
    byId(type + 'Previous').addEventListener('click', () => { if (state.page > 1) { state.page--; loadTable(type); } });
    byId(type + 'Next').addEventListener('click', () => { if (state.page < state.pages) { state.page++; loadTable(type); } });
  }
  bootstrap();
})();
