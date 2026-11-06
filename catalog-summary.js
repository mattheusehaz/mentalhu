(() => {
  'use strict';
  const box = document.getElementById('catalogSummary');
  if (!box) return;
  async function update() {
    try {
      const response = await fetch('/api/public/directory-summary', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) return;
      const data = await response.json();
      if (!Number.isInteger(data.total) || data.total < 0 || !Number.isInteger(data.categories)) return;
      box.dataset.total = String(data.total);
      const title = box.querySelector('strong'), description = box.querySelector('span'), link = box.querySelector('a');
      if (title) title.textContent = data.total + ' adatlap';
      if (description) description.textContent = data.categories + ' kategóriában. A főoldal csak ízelítő; a teljes lista itt érhető el.';
      if (link) { link.href = '/szolgaltatok'; link.textContent = 'Mind a ' + data.total + ' adatlap megtekintése →'; }
    } catch { /* Keep the server-rendered count or static link; never fabricate zero. */ }
  }
  update();
})();
