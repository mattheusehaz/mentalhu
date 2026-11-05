/* Progressive enhancement: navigation and all 21 categories work without JS. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = name => '<svg class="icon" viewBox="0 0 48 48" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {credentials:'same-origin', ...options, headers:{Accept:'application/json', ...(options.headers || {})}, signal:controller.signal});
      if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('A szolgáltatás jelenleg nem érhető el. Kérjük, próbáld újra később.');
      const data = await response.json();
      if (!response.ok) throw new Error(response.status >= 500 ? 'A szolgáltatás átmenetileg nem érhető el. Kérjük, próbáld újra később.' : (data.error || 'A kérés nem sikerült.'));
      return data;
    } finally { clearTimeout(timer); }
  }
  async function loadCounts() {
    try {
      const data = await request('/api/public/categories');
      if (!Array.isArray(data)) return;
      // The legacy API returns all-zero defaults on database failure: do not display
      // those as measured counts. Preserve the complete static navigation instead.
      if (!data.some(c => Number(c.listing_count) > 0)) return;
      const map = new Map(data.map(c => [String(c.slug), Number(c.listing_count)]));
      document.querySelectorAll('[data-count]').forEach(node => {
        const count = map.get(node.dataset.count);
        if (!Number.isInteger(count) || count < 0) return;
        node.textContent = '(' + count + ')';
        node.hidden = false;
      });
    } catch { /* The complete HTML category menu remains available. */ }
  }
  function providerCard(item) {
    const name = String(item.name || 'Szolgáltató');
    const categories = Array.isArray(item.categories) ? item.categories.filter(c => c && c.name).slice(0, 2) : [];
    const image = /^\/media\/\d+$/.test(item.profile_image_url || '') ? item.profile_image_url : null;
    const cover = image ? '<img src="'+esc(image)+'" alt="'+esc(name)+'" loading="lazy" width="400" height="260">' : '<span class="provider-initial" aria-hidden="true">'+esc(name.charAt(0))+'</span>';
    return '<a class="provider-card" href="/szolgaltato/'+encodeURIComponent(item.slug)+'"><div class="provider-art">'+cover+'</div><div class="provider-info"><h3>'+esc(name)+'</h3><div class="provider-location">'+icon('pin')+esc(item.city || (item.online_available ? 'Online' : 'Helyszín az adatlapon'))+'</div><div class="provider-tags">'+categories.map(c => '<span>'+esc(c.name)+'</span>').join('')+(item.online_available?'<span>Online is</span>':'')+'</div>'+(item.verified?'<span class="verified">✓ Ellenőrzött adatok</span>':'')+'</div></a>';
  }
  async function loadProviders() {
    const box = byId('featuredListings'), status = byId('catalogStatus');
    if (!box) return;
    try {
      const data = await request('/api/public/listings?limit=9');
      if (!Array.isArray(data)) throw new Error('invalid data');
      const listings = data.filter(item => item && typeof item.slug === 'string' && item.slug && typeof item.name === 'string');
      if (!listings.length) {
        if (status) status.textContent = 'Jelenleg nincs megjeleníthető szolgáltatói adatlap. A kategóriák között tovább böngészhetsz.';
        return;
      }
      box.innerHTML = listings.map(providerCard).join('');
      box.querySelectorAll('img').forEach(img => img.addEventListener('error', () => {
        const replacement = document.createElement('span');
        replacement.className = 'provider-initial'; replacement.textContent = (img.alt || 'M').charAt(0);
        replacement.setAttribute('aria-hidden','true'); img.replaceWith(replacement);
      }, {once:true}));
      if (status) status.textContent = '';
      const next = byId('nextProviders');
      if (next) next.hidden = listings.length <= 3;
    } catch {
      if (status) status.textContent = 'A szolgáltatói adatlapokat most nem sikerült lekérni. A kategóriák továbbra is elérhetők.';
    }
  }
  byId('nextProviders')?.addEventListener('click', () => {
    const box = byId('featuredListings'); if (!box) return;
    const end = box.scrollLeft + box.clientWidth >= box.scrollWidth - 8;
    box.scrollTo({left:end?0:box.scrollLeft+box.clientWidth*.9, behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  });
  // Native GET search deliberately has no submit interceptor: filters also work
  // without JavaScript and the online checkbox is included by the browser.
  const form = byId('submitForm');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const message = byId('submitMsg'), button = form.querySelector('button[type="submit"]');
    const fd = new FormData(form), payload = Object.fromEntries(fd.entries());
    payload.online_available = fd.has('online_available'); payload.consent = fd.has('consent');
    if (button) button.disabled = true;
    if (message) { message.className = 'form-message'; message.textContent = 'Beküldés…'; }
    try {
      const data = await request('/api/directory/submit', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
      if (data.ok !== true) throw new Error('A beküldés nem sikerült.');
      if (message) message.textContent = 'Köszönjük! A jelentkezésed megérkezett, a megjelenés előtt átnézzük az adatokat.';
      form.reset();
    } catch (error) {
      if (message) { message.className = 'form-message error'; message.textContent = error.name === 'AbortError' ? 'A kapcsolat időtúllépés miatt megszakadt. Az adatok megmaradtak, próbáld újra.' : String(error.message || 'Nem sikerült a beküldés.').slice(0,250); }
    } finally { if (button) button.disabled = false; }
  });
  document.querySelectorAll('.mobile-menu a').forEach(link => link.addEventListener('click', () => {const menu=link.closest('details');if(menu)menu.open=false;}));
  loadCounts(); loadProviders();
})();
