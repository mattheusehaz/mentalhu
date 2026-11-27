/* Progressive enhancement for the shared magazine and directory interface. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = name => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  function safeNext(value) {
    if (typeof value !== 'string' || value.length > 500 || /[\\\r\n\0]/.test(value)) return '/fiokom';
    if (value === '/fiokom' || value === '/fiokom?szolgaltato=1' || value === '/fiokom/ugyfelek') return value;
    return /^\/szolgaltato\/[a-zA-Z0-9_-]+(?:#ertekelesek)?$/.test(value) ? value : '/fiokom';
  }
  let accountSessionRequest,accountSessionGeneration=0,accountSessionPending=false;
  function updateAccountHeader(session) {
    const authenticated = session?.authenticated === true;
    $$('[data-account-login]').forEach(link => {link.textContent=authenticated?'Fiókom':'Belépés';link.href=authenticated?'/fiokom':'/belepes';});
    $$('[data-account-register]').forEach(link => {link.hidden=authenticated;});
    $$('[data-provider-join]').forEach(link => {link.href=authenticated?'/fiokom?szolgaltato=1':'/regisztracio?next=%2Ffiokom%3Fszolgaltato%3D1';link.textContent=authenticated?'Szolgáltatói adatlapom':'Regisztráció és csatlakozás';});
    $$('[data-provider-join-login]').forEach(link => {link.hidden=authenticated;});
    window.dispatchEvent(new CustomEvent('mental-account-change',{detail:session}));
  }
  async function accountSession(force=false) {
    if (!accountSessionRequest || (force && !accountSessionPending)) {
      const generation=++accountSessionGeneration;
      accountSessionPending=true;
      accountSessionRequest=(async()=>{
      const response=await fetch('/api/account/session',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},referrerPolicy:'same-origin',signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error('A fiókadatok most nem érhetők el.');
      const result=await response.json();if(generation===accountSessionGeneration)updateAccountHeader(result);return result;
      })().catch(error=>{if(generation===accountSessionGeneration)accountSessionRequest=null;throw error;}).finally(()=>{if(generation===accountSessionGeneration)accountSessionPending=false;});
    }
    return accountSessionRequest;
  }
  window.MentalAccount={safeNext,session:accountSession,updateSession:updateAccountHeader};
  void accountSession().catch(()=>{});
  window.addEventListener('pageshow',event=>{if(event.persisted)void accountSession(true).catch(()=>{});});
  const safeArticleUrl = value => typeof value === 'string' && /^\/cikk\/[a-zA-Z0-9%._~-]+$/.test(value) ? value : '';
  const safeImage = value => typeof value === 'string' && /^\/(?:assets\/[a-zA-Z0-9._/-]+|media\/\d+)$/.test(value) && !value.includes('..') ? value : '';
  const key = 'mental-saved-articles-v1';
  let saved = [];
  let toastTimer, searchTimer, searchController, searchSequence = 0;
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]');
    if (Array.isArray(stored)) saved = stored.filter(item => item && safeArticleUrl(item.url) && typeof item.title === 'string').slice(0,200);
  } catch { /* Saving remains available in memory when browser storage is unavailable. */ }

  function notify(message) {
    const box = $('#toast');
    if (!box) return;
    clearTimeout(toastTimer); box.textContent = message; box.classList.add('visible');
    toastTimer = setTimeout(() => box.classList.remove('visible'), 2600);
  }
  function resultMarkup(article, removable = false) {
    const url = safeArticleUrl(article.url);
    if (!url) return '';
    const image = safeImage(article.image || article.hero_url);
    const content = (image ? '<img src="' + escape(image) + '" alt="" width="88" height="73" loading="lazy">' : '<span class="result-no-image" aria-hidden="true">' + icon('book') + '</span>') + '<div class="dialog-result-content"><span class="category">' + escape(article.category || 'Magazin') + '</span><h3>' + escape(article.title) + '</h3></div>';
    return removable ? '<div class="saved-result"><a class="dialog-result" href="' + escape(url) + '">' + content + '</a><button type="button" class="icon-button" data-remove-saved="' + escape(url) + '" aria-label="Eltávolítás a mentett cikkekből: ' + escape(article.title) + '">' + icon('close') + '</button></div>' : '<a class="dialog-result" href="' + escape(url) + '">' + content + '</a>';
  }
  function refreshSaved() {
    const count = $('#saved-count');
    if (count) { count.textContent = saved.length; count.hidden = saved.length === 0; }
    $$('[data-save-article]').forEach(button => {
      const selected = saved.some(item => item.url === button.dataset.saveArticle);
      button.classList.toggle('is-saved', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', (selected ? 'Mentés visszavonása: ' : 'Cikk mentése: ') + (button.dataset.articleTitle || 'Cikk'));
    });
    const box = $('#saved-results');
    if (box) box.innerHTML = saved.length ? saved.map(article => resultMarkup(article, true)).join('') : '<p class="dialog-empty">Még nincs mentett cikked. A cikk képe mellett lévő könyvjelzővel elteheted későbbre az érdekes írásokat.</p>';
  }
  function saveState() { try { localStorage.setItem(key, JSON.stringify(saved)); } catch {} refreshSaved(); }
  refreshSaved();

  async function searchArticles(query = '') {
    const box = $('#search-results');
    if (!box) return;
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    const sequence = ++searchSequence;
    const timeout = setTimeout(() => controller.abort(), 10000);
    box.innerHTML = '<p class="dialog-empty">Cikkek keresése…</p>';
    const params = new URLSearchParams({limit:'8',paginated:'true'});
    if (query.trim()) params.set('q',query.trim());
    try {
      const response = await fetch('/api/public/articles?' + params, {headers:{Accept:'application/json'},cache:'no-store',signal:controller.signal});
      if (!response.ok) throw new Error('request_failed');
      const data = await response.json();
      if (sequence !== searchSequence) return;
      const items = Array.isArray(data.items) ? data.items : [];
      box.innerHTML = items.length ? items.map(article => resultMarkup(article)).join('') : '<p class="dialog-empty">Nincs találat erre a kifejezésre. Próbálj másik témát, vagy nézd meg a <a href="/cikkek">teljes magazint</a>.</p>';
      if (data.total > items.length) {
        const archive = '/cikkek' + (query.trim() ? '?q=' + encodeURIComponent(query.trim()) : '');
        box.insertAdjacentHTML('beforeend','<a class="search-all text-link" href="' + escape(archive) + '">Mind a ' + Number(data.total) + ' találat megtekintése</a>');
      }
    } catch (error) {
      if (sequence === searchSequence) box.innerHTML = '<p class="dialog-empty">A cikkek most nem tölthetők be. Próbáld meg újra, vagy nyisd meg a <a href="/cikkek">magazint</a>.</p>';
    } finally { clearTimeout(timeout); }
  }
  $('#article-search')?.addEventListener('input', event => {
    clearTimeout(searchTimer);
    // Invalidate the in-flight query before the debounce finishes.
    searchSequence++; searchController?.abort();
    searchTimer = setTimeout(() => searchArticles(event.target.value), 250);
  });
  document.addEventListener('click', event => {
    const save = event.target.closest('[data-save-article]');
    if (save) {
      event.preventDefault();
      const url = safeArticleUrl(save.dataset.saveArticle);
      if (!url) return;
      if (saved.some(item => item.url === url)) { saved = saved.filter(item => item.url !== url); notify('Cikk eltávolítva a mentésekből.'); }
      else {
        saved.unshift({url,title:String(save.dataset.articleTitle || 'Cikk').slice(0,500),image:safeImage(save.dataset.articleImage),category:String(save.dataset.articleCategory || '').slice(0,100)});
        saved = saved.slice(0,200); notify('Cikk elmentve. A könyvjelzőnél találod.');
      }
      saveState(); return;
    }
    const remove = event.target.closest('[data-remove-saved]');
    if (remove) {
      const position = $$('[data-remove-saved]').indexOf(remove);
      saved = saved.filter(item => item.url !== remove.dataset.removeSaved);
      saveState();
      const remaining = $$('[data-remove-saved]');
      (remaining[Math.min(position, remaining.length - 1)] || $('#saved-dialog [data-close-dialog]'))?.focus();
      notify('Cikk eltávolítva a mentésekből.');
      return;
    }
    if (event.target.closest('[data-open-search]')) {
      const dialog = $('#search-dialog');
      if (!dialog?.showModal) { location.href = '/cikkek'; return; }
      dialog.showModal(); $('#article-search')?.focus(); searchArticles($('#article-search')?.value || '');
    }
    if (event.target.closest('[data-open-saved]')) {
      const dialog = $('#saved-dialog');
      if (dialog?.showModal) dialog.showModal();
    }
    if (event.target.closest('[data-close-dialog]')) event.target.closest('dialog')?.close();
    const menuLink = event.target.closest('.mobile-menu a');
    if (menuLink) menuLink.closest('details').open = false;
  });
  $$('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') $$('.mobile-menu[open]').forEach(menu => { menu.open = false; }); });
})();
