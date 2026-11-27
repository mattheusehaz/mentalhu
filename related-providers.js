(() => {
  'use strict';
  const root = document.querySelector('[data-related-providers]');
  if (!root || !root.dataset.articleSlug) return;
  const select = name => root.querySelector('[data-provider-' + name + ']');
  const controls = select('location-controls'), picker = select('city-picker');
  const form = select('city-form'), query = form.querySelector('input');
  const searchResults = select('city-results'), searchStatus = select('city-status');
  const results = select('results'), status = select('location-status');
  const useLocation = select('use-location'), resetLocation = select('reset-location'), retry = select('location-retry');
  const storageKey = 'mental-provider-location-v1';
  const endpoint = '/api/public/articles/' + encodeURIComponent(root.dataset.articleSlug) + '/providers';
  let generation = 0, searchGeneration = 0, activeRequest = null, activeSearch = null, searchTimer = null;
  let lastRequest = {}, lastRetry = null;

  function canonicalCity(value, explicitOnly = false) {
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 100 || typeof value.name !== 'string' || !value.name || value.name.length > 150) return null;
    const source = ['manual', 'browser'].includes(value.source) ? value.source : 'ip';
    return explicitOnly && source === 'ip' ? null : {id: value.id, name: value.name, source};
  }
  function savedCity() {
    try { return canonicalCity(JSON.parse(localStorage.getItem(storageKey)), true); } catch { return null; }
  }
  function remember(city) {
    try {
      if (city && ['manual', 'browser'].includes(city.source)) localStorage.setItem(storageKey, JSON.stringify({id: city.id, name: city.name, source: city.source}));
      else localStorage.removeItem(storageKey);
    } catch { /* Location controls still work when browser storage is unavailable. */ }
  }
  function message(text = '', error = false) {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('is-error', error);
  }
  function showLocation(city) {
    select('location-name').textContent = city ? city.name : 'Válassz települést';
    select('location-source').textContent = city ? (city.source === 'manual' ? 'Választott település' : city.source === 'browser' ? 'Helyzet alapján' : 'Becsült hely') : 'Közeli szakembert keresel?';
    select('location-hint').textContent = city ? 'Először a közelben elérhető, majd az online szakembereket mutatjuk.' : 'A közeli találatokhoz add meg a településed. Addig online szakembereket mutatunk.';
    picker.querySelector('summary').textContent = city ? 'Település módosítása' : 'Település kiválasztása';
    resetLocation.hidden = !city || city.source === 'ip';
    root.dataset.providerCityId = city ? city.id : '';
    root.dataset.providerCityName = city ? city.name : '';
    root.dataset.providerCitySource = city ? city.source : '';
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function showProviders(items, city) {
    const seen = new Set();
    const providers = items.filter(item => {
      if (!item || typeof item.slug !== 'string' || !item.slug || typeof item.name !== 'string' || !item.name || seen.has(item.slug)) return false;
      if (!['local', 'nearby', 'online'].includes(item.match_type) || (!city && item.match_type !== 'online')) return false;
      seen.add(item.slug);
      return true;
    }).slice(0, 4);
    if (!providers.length) {
      results.replaceChildren(node('p', 'reader-providers-empty', 'Ehhez a témához most nincs ' + (city ? 'közeli vagy online' : 'online') + ' találat. Böngéssz a katalógusban szakterület és település szerint.'));
      return 0;
    }
    const list = node('ul', 'reader-provider-list');
    providers.forEach(provider => {
      const item = node('li'), card = node('a', 'reader-provider-card');
      card.href = '/szolgaltato/' + encodeURIComponent(provider.slug);
      if (provider.category_name) card.append(node('span', 'reader-provider-category', provider.category_name));
      card.append(node('h3', '', provider.name));
      const online = provider.match_type === 'online';
      if (online) card.append(node('span', 'reader-provider-match', 'Online konzultáció'));
      const nearby = provider.match_type === 'nearby' && Number.isFinite(provider.distance_km) && provider.distance_km >= 0;
      const text = [provider.city, nearby ? 'kb. ' + Math.round(provider.distance_km) + ' km' : '', !online && provider.online_available ? 'Online is' : ''].filter(Boolean).join(' · ');
      if (text) {
        const place = node('span', 'reader-provider-location', text);
        if (nearby) place.title = 'Településközpontok közötti becsült távolság';
        card.append(place);
      }
      const open = node('span', 'reader-provider-open', 'Adatlap megnyitása '), arrow = node('span', '', '↗');
      arrow.setAttribute('aria-hidden', 'true');
      open.append(arrow);
      card.append(open);
      item.append(card);
      list.append(item);
    });
    results.replaceChildren(list);
    return providers.length;
  }
  async function json(url, {body, controller} = {}) {
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {Accept: 'application/json', ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
        credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
      });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error('Location request failed'), {status: response.status});
      return data;
    } finally { clearTimeout(timer); }
  }
  function beginChoice() {
    generation++;
    activeRequest?.abort();
    activeRequest = null;
    results.removeAttribute('aria-busy');
    useLocation.disabled = false;
    retry.hidden = true;
    lastRetry = null;
    return generation;
  }
  async function loadProviders(body, {choice = beginChoice(), persist = false, discardInvalidSaved = false} = {}) {
    if (choice !== generation) return;
    lastRequest = body;
    const controller = new AbortController();
    activeRequest = controller;
    results.replaceChildren();
    results.setAttribute('aria-busy', 'true');
    message('Szakemberek keresése…');
    try {
      const data = await json(endpoint, {body, controller});
      if (choice !== generation) return;
      if (!Array.isArray(data.items)) throw new Error('Invalid recommendation response');
      const city = canonicalCity(data.location);
      if (data.location && !city) throw new Error('Invalid city response');
      if (body.city && (!city || city.id !== body.city)) throw new Error('Mismatched city response');
      if (persist) remember(city);
      showLocation(city);
      const count = showProviders(data.items, city);
      message((city ? city.name + ': ' : '') + (count ? count + ' kapcsolódó szakember' + (city ? '.' : ' online konzultációval.') : 'Most nincs megfelelő találat.'));
    } catch (error) {
      if (choice !== generation) return;
      if (discardInvalidSaved && [400, 404, 422].includes(error.status)) {
        remember(null);
        return loadProviders({automatic: true});
      }
      message('A szakemberajánlót most nem sikerült betölteni. Próbáld újra, vagy válassz másik települést.', true);
      lastRetry = () => loadProviders(lastRequest, {persist});
      retry.hidden = false;
    } finally {
      if (choice === generation) {
        results.removeAttribute('aria-busy');
        activeRequest = null;
        useLocation.disabled = false;
      }
    }
  }

  async function searchCities() {
    clearTimeout(searchTimer);
    const value = query.value.trim().slice(0, 100), choice = ++searchGeneration;
    activeSearch?.abort();
    searchResults.replaceChildren();
    searchResults.removeAttribute('aria-busy');
    if (value.length === 1) { searchStatus.textContent = 'Írj be legalább 2 karaktert.'; return; }
    const controller = new AbortController();
    activeSearch = controller;
    searchStatus.textContent = 'Települések keresése…';
    searchResults.setAttribute('aria-busy', 'true');
    try {
      const data = await json('/api/public/provider-locations?q=' + encodeURIComponent(value), {controller});
      if (choice !== searchGeneration) return;
      if (!Array.isArray(data.items)) throw new Error('Invalid city search response');
      const found = data.items.map(item => canonicalCity({...item, source: 'manual'})).filter(Boolean).slice(0, 8);
      found.forEach(city => {
        const item = node('li'), button = node('button', 'provider-city-result', city.name);
        button.type = 'button';
        button.setAttribute('aria-label', city.name + ' kiválasztása');
        button.addEventListener('click', () => {
          picker.open = false;
          picker.querySelector('summary').focus({preventScroll: true});
          remember(city);
          showLocation(city);
          void loadProviders({city: city.id, source: 'manual'}, {persist: true});
        });
        item.append(button);
        searchResults.append(item);
      });
      searchStatus.textContent = found.length ? 'Válaszd ki a települést.' : 'Nem találtunk ilyen települést. Próbáld rövidebb névvel.';
    } catch {
      if (choice === searchGeneration) searchStatus.textContent = 'A településkereső most nem elérhető. Próbáld újra a Keresés gombbal.';
    } finally {
      if (choice === searchGeneration) { searchResults.removeAttribute('aria-busy'); activeSearch = null; }
    }
  }
  async function locate() {
    const choice = beginChoice();
    if (!navigator.geolocation) {
      message('Ebben a böngészőben nem érhető el a helymeghatározás. Válassz települést.', true);
      return;
    }
    useLocation.disabled = true;
    message('A hozzávetőleges helyed meghatározása…');
    try {
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, {enableHighAccuracy: false, timeout: 10000, maximumAge: 300000}));
      if (choice !== generation) return;
      const controller = new AbortController();
      activeRequest = controller;
      // Only a rounded position reaches our own resolver; storage contains a city only.
      const data = await json('/api/public/provider-location/resolve', {controller, body: {
        latitude: Math.round(position.coords.latitude * 100) / 100,
        longitude: Math.round(position.coords.longitude * 100) / 100,
        accuracy: Math.max(1500, Math.round(position.coords.accuracy))
      }});
      if (choice !== generation) return;
      const city = canonicalCity(data.location);
      if (!city) {
        message('Nem sikerült magyarországi települést azonosítani. Válaszd ki kézzel a településed.', true);
        return;
      }
      city.source = 'browser';
      remember(city);
      showLocation(city);
      await loadProviders({city: city.id, source: 'browser'}, {choice, persist: true});
    } catch (error) {
      if (choice !== generation) return;
      message(error.code === 1 ? 'A helyhozzáférés nem engedélyezett. A települést kézzel is kiválaszthatod.' : 'A helyzeted most nem határozható meg. Válaszd ki kézzel a településed.', true);
    } finally {
      if (choice === generation) { useLocation.disabled = false; activeRequest = null; }
    }
  }

  controls.hidden = false;
  form.addEventListener('submit', event => { event.preventDefault(); void searchCities(); });
  query.addEventListener('input', () => {
    clearTimeout(searchTimer);
    // Old search hits must not stay selectable under a different typed city.
    searchGeneration++;
    activeSearch?.abort();
    searchResults.replaceChildren();
    searchResults.removeAttribute('aria-busy');
    searchStatus.textContent = '';
    searchTimer = setTimeout(() => { void searchCities(); }, 250);
  });
  query.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && searchResults.querySelector('button')) { event.preventDefault(); searchResults.querySelector('button').focus(); }
  });
  picker.addEventListener('toggle', () => { if (picker.open) { query.focus({preventScroll: true}); void searchCities(); } });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); picker.open = false; picker.querySelector('summary').focus({preventScroll: true}); }
  });
  useLocation.addEventListener('click', () => { void locate(); });
  resetLocation.addEventListener('click', () => { remember(null); showLocation(null); void loadProviders({automatic: true}); });
  retry.addEventListener('click', () => { if (lastRetry) void lastRetry(); });
  const saved = savedCity();
  if (saved && (saved.id !== root.dataset.providerCityId || saved.source !== root.dataset.providerCitySource)) {
    void loadProviders({city: saved.id, source: saved.source}, {persist: true, discardInvalidSaved: true});
  }
})();
