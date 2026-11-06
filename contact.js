/* MENTÁL.hu contact request. No health details, uploads, analytics or local storage. */
(() => {
  'use strict';
  const panel = document.querySelector('[data-contact-slug]');
  if (!panel) return;
  const form = document.getElementById('contactInquiryForm');
  const availability = document.getElementById('contactAvailability');
  const message = document.getElementById('contactInquiryMessage');
  const button = form?.querySelector('button[type="submit"]');
  let configuration, sending = false;
  async function request(url, options = {}) {
    const r = await fetch(url, {credentials:'same-origin', cache:'no-store', ...options, signal:AbortSignal.timeout(20000), headers:{Accept:'application/json', ...(options.headers || {})}});
    if (!(r.headers.get('content-type') || '').includes('application/json')) throw new Error('A kapcsolatfelvételi szolgáltatás most nem érhető el.');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'A kérést nem sikerült feldolgozni.');
    return data;
  }
  async function initialize() {
    try {
      configuration = await request('/api/contact/form/' + encodeURIComponent(panel.dataset.contactSlug));
      if (!configuration.enabled) {
        availability.textContent = 'A portálon keresztüli üzenetküldés ezen az adatlapon még nem aktív. Addig a fenti weboldalon vagy forrásoldalon található elérhetőséget használd.';
        return;
      }
      document.getElementById('contactConsentText').textContent = configuration.consent_text;
      availability.textContent = !configuration.recipient_ready
        ? 'Ehhez az adatlaphoz még nincs használható címzetti e-mail-cím. A kérésedet a szerkesztőség rögzíti, de közvetlen továbbítását nem tudjuk vállalni.'
        : !configuration.mail_ready
          ? 'Az e-mail-továbbítás még nincs beállítva. A kérésed az adminisztrációban mentésre kerül, de most még nem jut el e-mailben a szolgáltatóhoz.'
          : 'A megadott elérhetőségeidet a kiválasztott szolgáltató kapja meg. A telefonszám megadása önkéntes.';
      form.hidden = false;
    } catch (e) { availability.textContent = e.name === 'TimeoutError' ? 'A kapcsolat ellenőrzése időtúllépés miatt nem sikerült. Próbáld az oldalt újratölteni.' : e.message; }
  }
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || !configuration?.enabled || !form.reportValidity()) return;
    const values = new FormData(form);
    const payload = Object.fromEntries(values.entries());
    payload.consent = values.has('consent'); payload.adult = values.has('adult');
    payload.request_key = configuration.request_key;
    sending = true; button.disabled = true; message.textContent = 'A kérés rögzítése…';
    try {
      const data = await request('/api/contact/inquiries/' + encodeURIComponent(panel.dataset.contactSlug), {
        method:'POST', headers:{'Content-Type':'application/json','X-Contact-CSRF':configuration.csrf_token}, body:JSON.stringify(payload)
      });
      message.textContent = data.message + ' Azonosító: ' + data.id;
      message.className = 'contact-success';
      form.reset();
      form.querySelectorAll('input, select, button').forEach(input => { input.disabled = true; });
    } catch (e) {
      message.textContent = ['TimeoutError','AbortError'].includes(e.name)
        ? 'Nem érkezett visszaigazolás. Újrapróbálhatod ugyanezt a kérést; az azonosítójával megakadályozzuk a dupla rögzítést.' : e.message;
      message.className = 'contact-error'; button.disabled = false;
    } finally { sending = false; }
  });
  initialize();
})();
