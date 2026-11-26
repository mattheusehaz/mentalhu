(() => {
  'use strict';
  const root = document.getElementById('subscribersView');
  if (!root) return;
  const byId = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const state = {open:false, generation:0, page:1, pages:1, query:'', status:'', dashboard:null, csrf:'', controller:null, listController:null, listGeneration:0, mutation:false, previewBusy:false};
  const dateFormatter = new Intl.DateTimeFormat('hu-HU', {timeZone:'Europe/Budapest',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const numberFormatter = new Intl.NumberFormat('hu-HU');
  const labels = {
    active:'Aktív', pending:'Megerősítésre vár', needs_preferences:'Témaválasztás / megerősítés szükséges', unsubscribed:'Leiratkozott',
    queued:'Küldésre vár', needs_mail:'Levélküldés beállítására vár', sending:'Átadás folyamatban', accepted:'A levélküldő átvette',
    failed:'Sikertelen', uncertain:'Ellenőrzést igényel', skipped:'Kihagyva', completed:'Feldolgozva', completed_with_errors:'Feldolgozva, ellenőrzéssel', empty:'Nincs küldhető válogatás', preparing:'Összeállítás alatt'
  };
  const date = value => value && Number.isFinite(new Date(value).getTime()) ? dateFormatter.format(new Date(value)) : '–';
  const count = value => numberFormatter.format(Number(value) || 0);
  const badge = value => '<span class="newsletter-state" data-state="' + escape(value) + '">' + escape(labels[value] || value || '–') + '</span>';
  const empty = message => '<p class="newsletter-admin-empty">' + escape(message) + '</p>';
  function notice(id, message, error = false) {
    const element = byId(id);
    element.textContent = message;
    element.className = error ? 'msg error' : 'msg';
    element.setAttribute('role', error ? 'alert' : 'status');
  }
  async function api(url, {body, signal} = {}) {
    const response = await fetch(url, {
      method:body === undefined ? 'GET' : 'POST', credentials:'same-origin', referrerPolicy:'same-origin', signal,
      headers:{'Accept':'application/json',...(body === undefined ? {} : {'Content-Type':'application/json','X-Provider-CSRF':state.csrf})},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})
    });
    const data = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : {};
    if (response.status === 401) {
      window.MentalNewsletterAdmin.reset();
      if (typeof window.showLogin === 'function') window.showLogin();
      throw new Error('A munkamenet lejárt. Kérjük, jelentkezz be újra.');
    }
    if (!response.ok) throw new Error(data.error || (response.status === 429 ? 'Túl sok kérés érkezett. Próbáld újra később.' : 'A művelet nem sikerült. Kérjük, próbáld újra.'));
    return data;
  }
  function previewTopics() {
    return [...byId('newsletterPreviewTopics').querySelectorAll('input:checked')].map(input => input.value);
  }
  function updatePreview() {
    const topics = previewTopics();
    const link = byId('newsletterPreviewLink');
    link.href = '/api/admin/newsletter/preview?topics=' + encodeURIComponent(topics.join(','));
    link.setAttribute('aria-disabled', String(!topics.length));
    link.tabIndex = topics.length ? 0 : -1;
    byId('newsletterTestButton').disabled = !topics.length || !state.dashboard?.mail_ready || state.previewBusy;
  }
  function renderTopics(topics) {
    const target = byId('newsletterPreviewTopics');
    if (target.querySelector('input')) return;
    target.innerHTML = topics.map(topic => '<label><input type="checkbox" name="preview_topics" value="' + escape(topic.key) + '"' + (topic.key === 'all' ? ' checked' : '') + '><span>' + escape(topic.label) + '</span></label>').join('');
    updatePreview();
  }
  function renderDashboard(data) {
    state.dashboard = data;
    state.csrf = data.csrf_token || '';
    byId('newsletterScheduleState').textContent = data.enabled ? 'Az automatikus hírlevél aktív' : 'Az automatikus hírlevél szünetel';
    byId('newsletterNextSend').textContent = data.next_send_at ? (data.enabled ? 'Következő heti időpont: ' : 'Ütemezett heti időpont: ') + date(data.next_send_at) : '';
    byId('newsletterMailReady').replaceChildren();
    if (data.mail_ready) byId('newsletterMailReady').textContent = 'A levélküldés be van állítva.';
    else {
      byId('newsletterMailReady').append('A levélküldést még be kell állítani. ');
      const link = document.createElement('a');
      link.href = '/admin/kapcsolatfelvetelek.html';
      link.textContent = 'Levélküldési beállítások →';
      byId('newsletterMailReady').append(link);
    }
    const toggle = byId('newsletterPauseToggle');
    toggle.textContent = data.enabled ? 'Automatikus küldés szüneteltetése' : 'Automatikus küldés bekapcsolása';
    toggle.disabled = state.mutation || !state.csrf;
    byId('newsletterActiveCount').textContent = count(data.counts?.active);
    byId('newsletterPendingCount').textContent = count(data.counts?.pending);
    byId('newsletterLegacyCount').textContent = count(data.counts?.needs_preferences);
    byId('newsletterUnsubscribedCount').textContent = count(data.counts?.unsubscribed);
    byId('newsletterTestRecipient').textContent = data.test_recipient || '';
    renderTopics(data.topics || []);
    updatePreview();
    renderCampaigns(data.campaigns || []);
  }
  function renderSubscribers(data) {
    state.page = Number(data.page) || 1;
    state.pages = Math.max(1,Number(data.pages) || 1);
    byId('newsletterSubscriberCount').textContent = count(data.total) + ' feliratkozó';
    byId('newsletterPage').textContent = state.page + ' / ' + state.pages + '. oldal';
    byId('newsletterPrevious').disabled = state.page <= 1;
    byId('newsletterNext').disabled = state.page >= state.pages;
    const rows = Array.isArray(data.items) ? data.items : [];
    byId('newsletterSubscribers').innerHTML = rows.length ? '<table class="table"><thead><tr><th scope="col">Név és e-mail-cím</th><th scope="col">Választott témák</th><th scope="col">Állapot</th><th scope="col">Utolsó küldés</th><th scope="col">Művelet</th></tr></thead><tbody>' + rows.map(item => {
      const status = item.status === 'unsubscribed' ? 'unsubscribed' : item.needs_preferences ? 'needs_preferences' : item.status;
      const topicNames = item.topic_labels || (item.topics || []).map(key => state.dashboard?.topics?.find(topic => topic.key === key)?.label || key);
      return '<tr><td><strong>' + escape(item.name || 'Nincs megadott név') + '</strong><small>' + escape(item.email) + '</small><small>Feliratkozás: ' + escape(date(item.created_at)) + '</small></td><td>' + escape(topicNames.length ? topicNames.join(', ') : 'Még nincs témaválasztás') + '</td><td>' + badge(status) + '</td><td>' + escape(date(item.last_sent_at)) + '</td><td>' + (item.status === 'unsubscribed' ? '–' : '<button type="button" data-newsletter-unsubscribe-id="' + escape(item.id) + '" data-newsletter-email="' + escape(item.email) + '">Leiratkoztatás</button>') + '</td></tr>';
    }).join('') + '</tbody></table>' : empty('A megadott feltételekkel nincs feliratkozó.');
  }
  function renderCampaigns(items) {
    byId('newsletterCampaigns').innerHTML = items.length ? '<table class="table"><thead><tr><th scope="col">Heti kiadás</th><th scope="col">Állapot</th><th scope="col">Átvett / várakozó</th><th scope="col">Kihagyott / hibás</th><th scope="col">Részletek</th></tr></thead><tbody>' + items.map(item => '<tr><td><strong>' + escape(date(item.scheduled_at)) + '</strong><small>' + escape(date(item.window_start)) + ' – ' + escape(date(item.window_end)) + '</small></td><td>' + badge(item.status) + '</td><td>' + count(item.accepted_count) + ' / ' + count(item.queued_count) + '</td><td>' + count(item.skipped_count) + ' / ' + count((Number(item.failed_count) || 0) + (Number(item.uncertain_count) || 0)) + (Number(item.uncertain_count) ? '<small>Ellenőrzést igényel: ' + count(item.uncertain_count) + '</small>' : '') + '</td><td><button type="button" data-newsletter-campaign-id="' + escape(item.id) + '">Címzettek és napló</button></td></tr>').join('') + '</tbody></table>' : empty('Még nem volt heti kiküldés. Az első kiadás az ütemezett pénteki időpontban áll össze.');
  }
  async function loadSubscribers() {
    state.listController?.abort();
    state.listController = new AbortController();
    const generation = ++state.listGeneration;
    const target = byId('newsletterSubscribers');
    target.setAttribute('aria-busy','true');
    byId('newsletterPrevious').disabled = true;byId('newsletterNext').disabled = true;
    try {
      const params = new URLSearchParams({q:state.query,status:state.status,page:String(state.page)});
      const data = await api('/api/admin/newsletter/subscribers?' + params,{signal:state.listController.signal});
      if (state.open && generation === state.listGeneration) renderSubscribers(data);
    } catch (error) {
      if (error.name !== 'AbortError' && generation === state.listGeneration && state.open) {
        notice('newsletterMessage',error.message,true);
        target.innerHTML = empty('A feliratkozókat most nem sikerült betölteni. A Frissítés gombbal újrapróbálhatod.');
      }
    } finally {if (generation === state.listGeneration) target.removeAttribute('aria-busy');}
  }
  async function refresh() {
    state.controller?.abort();
    state.controller = new AbortController();
    const generation = ++state.generation;
    notice('newsletterMessage','');
    byId('newsletterRefresh').disabled = true;
    try {
      const dashboard = await api('/api/admin/newsletter',{signal:state.controller.signal});
      if (!state.open || generation !== state.generation) return;
      renderDashboard(dashboard);
      await loadSubscribers();
    } catch (error) {
      if (error.name !== 'AbortError' && state.open && generation === state.generation) notice('newsletterMessage',error.message,true);
    } finally {if (generation === state.generation) byId('newsletterRefresh').disabled = false;}
  }
  async function showCampaign(id) {
    const dialog = byId('newsletterCampaignDialog');
    const generation = state.generation;
    byId('newsletterCampaignTitle').textContent = 'Kiküldés részletei';
    byId('newsletterCampaignDetails').innerHTML = empty('A küldési napló betöltése…');
    if (!dialog.open) dialog.showModal();
    dialog.dataset.campaignId = id;
    try {
      const data = await api('/api/admin/newsletter/campaigns/' + encodeURIComponent(id),{signal:state.controller?.signal});
      if (!state.open || generation !== state.generation || dialog.dataset.campaignId !== id) return;
      byId('newsletterCampaignTitle').textContent = 'Heti kiadás · ' + date(data.campaign?.scheduled_at);
      const rows = data.items || [];
      const total = Number(data.campaign?.recipient_count) || rows.length;
      byId('newsletterCampaignDetails').innerHTML = '<p>A napló a levélküldőnek történő átadást mutatja. A bizonytalan átadás ellenőrzést igényel; a rendszer nem küldi újra automatikusan ezeket a leveleket.</p>' + (total > rows.length ? '<p>Az összesen ' + count(total) + ' címzett első ' + count(rows.length) + ' bejegyzése látható.</p>' : '') + (rows.length ? '<div class="newsletter-admin-table" tabindex="0" role="region" aria-label="Kiküldés címzettjei"><table class="table"><thead><tr><th scope="col">Címzett</th><th scope="col">Cikkek</th><th scope="col">Küldési állapot</th><th scope="col">Időpont</th></tr></thead><tbody>' + rows.map(item => '<tr><td><strong>' + escape(item.name || 'Nincs megadott név') + '</strong><small>' + escape(item.email) + '</small></td><td>' + count(item.article_count) + '</td><td>' + badge(item.delivery_status) + (item.error_code ? '<small data-error-code>' + escape(item.error_code) + '</small>' : '') + '<small>Próbálkozások: ' + count(item.attempts) + '</small></td><td>' + escape(date(item.accepted_at || item.sent_at || item.updated_at)) + '</td></tr>').join('') + '</tbody></table></div>' : empty('Ehhez a kiadáshoz nincs küldési napló.'));
    } catch (error) {
      if (error.name !== 'AbortError' && dialog.dataset.campaignId === id) byId('newsletterCampaignDetails').textContent = error.message;
    }
  }
  byId('newsletterCampaignClose').addEventListener('click',() => byId('newsletterCampaignDialog').close());
  byId('newsletterSearchForm').addEventListener('submit',event => {
    event.preventDefault();state.page = 1;state.query = byId('newsletterSearch').value.trim();state.status = byId('newsletterStatus').value;void loadSubscribers();
  });
  byId('newsletterStatus').addEventListener('change',() => {state.status = byId('newsletterStatus').value;state.query = byId('newsletterSearch').value.trim();state.page = 1;void loadSubscribers();});
  byId('newsletterRefresh').addEventListener('click',() => void refresh());
  byId('newsletterPrevious').addEventListener('click',() => {if (state.page > 1) {state.page--;void loadSubscribers();}});
  byId('newsletterNext').addEventListener('click',() => {if (state.page < state.pages) {state.page++;void loadSubscribers();}});
  byId('newsletterPreviewTopics').addEventListener('change',event => {
    const input = event.target;
    if (input.name !== 'preview_topics') return;
    if (input.checked) byId('newsletterPreviewTopics').querySelectorAll('input').forEach(other => {
      if ((input.value === 'all' && other !== input) || (input.value !== 'all' && other.value === 'all')) other.checked = false;
    });
    updatePreview();
  });
  byId('newsletterPreviewLink').addEventListener('click',event => {if (!previewTopics().length) event.preventDefault();});
  byId('newsletterPreviewForm').addEventListener('submit',async event => {
    event.preventDefault();
    if (state.previewBusy || !state.dashboard?.mail_ready || !previewTopics().length || !state.csrf) return;
    state.previewBusy = true;updatePreview();notice('newsletterTestMessage','A tesztlevél előkészítése…');
    try {
      const result = await api('/api/admin/newsletter/test',{body:{topics:previewTopics()}});
      notice('newsletterTestMessage',result.message || 'A tesztlevelet küldésre előkészítettük.');
    } catch (error) {notice('newsletterTestMessage',error.message,true);}
    finally {state.previewBusy = false;updatePreview();}
  });
  byId('newsletterPauseToggle').addEventListener('click',async () => {
    if (state.mutation || !state.dashboard || !state.csrf) return;
    state.mutation = true;byId('newsletterPauseToggle').disabled = true;notice('newsletterMessage','');
    try {
      const enabled = !state.dashboard.enabled;
      await api('/api/admin/newsletter/settings',{body:{enabled}});
      state.mutation = false;await refresh();
      notice('newsletterMessage',enabled ? 'Az automatikus heti küldést bekapcsoltuk.' : 'Az automatikus heti küldést szüneteltetjük.');
    } catch (error) {notice('newsletterMessage',error.message,true);}
    finally {state.mutation = false;byId('newsletterPauseToggle').disabled = !state.csrf;}
  });
  root.addEventListener('click',async event => {
    const campaign = event.target.closest('[data-newsletter-campaign-id]');
    if (campaign) {void showCampaign(campaign.dataset.newsletterCampaignId);return;}
    const button = event.target.closest('[data-newsletter-unsubscribe-id]');
    if (!button || state.mutation || !state.csrf) return;
    if (!window.confirm('Leiratkoztatod ezt az e-mail-címet a heti hírlevélről?\n' + button.dataset.newsletterEmail)) return;
    state.mutation = true;button.disabled = true;notice('newsletterMessage','');
    try {
      await api('/api/admin/newsletter/subscribers/' + encodeURIComponent(button.dataset.newsletterUnsubscribeId) + '/unsubscribe',{body:{}});
      state.mutation = false;await refresh();notice('newsletterMessage','A címzettet leiratkoztattuk a hírlevélről.');
    } catch (error) {notice('newsletterMessage',error.message,true);}
    finally {state.mutation = false;if (button.isConnected) button.disabled = false;}
  });
  function close() {
    state.open = false;state.generation++;state.listGeneration++;state.controller?.abort();state.listController?.abort();
    byId('newsletterCampaignDialog').close();
  }
  window.MentalNewsletterAdmin = {
    open() {state.open = true;void refresh();}, close,
    reset() {
      close();state.csrf = '';state.dashboard = null;state.page = 1;state.pages = 1;state.query = '';state.status = '';
      state.mutation = false;state.previewBusy = false;
      byId('newsletterSearch').value = '';byId('newsletterStatus').value = '';byId('newsletterSubscribers').replaceChildren();
      byId('newsletterCampaigns').replaceChildren();byId('newsletterCampaignDetails').replaceChildren();byId('newsletterPreviewTopics').replaceChildren();
      byId('newsletterTestButton').disabled = true;byId('newsletterPauseToggle').disabled = true;
      notice('newsletterMessage','');notice('newsletterTestMessage','');
    }
  };
})();
