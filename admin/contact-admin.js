(() => {
  'use strict';
  const byId=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={needs_mail:'Levélküldő beállítására vár',needs_recipient:'Címzetti e-mail-címre vár',queued:'Küldésre vár',sending:'Küldés folyamatban',accepted:'Átvéve a levélküldőnél',failed:'Sikertelen',uncertain:'Bizonytalan eredmény',cancelled:'Leállítva',expired:'Személyes adatok törölve',new:'Új',in_progress:'Feldolgozás alatt',closed:'Lezárva'};
  let token='',page=1,pages=1,selected=null;
  const date=v=>v?new Date(v).toLocaleString('hu-HU'):'–';
  async function api(path,options={}) {
    const r=await fetch('/api/admin/contact/'+path,{credentials:'same-origin',cache:'no-store',...options,headers:{Accept:'application/json','Content-Type':'application/json','X-Contact-CSRF':token,...(options.headers||{})},signal:AbortSignal.timeout(30000)});
    if(r.status===401){byId('loginRequired').hidden=false;byId('contactAdminBody').hidden=true;throw Error('Adminisztrátori bejelentkezés szükséges.');}
    const data=await r.json();if(!r.ok)throw Error(data.error||data.code||'A művelet nem sikerült.');return data;
  }
  async function loadSettings() {
    const s=await api('settings');token=s.csrf_token||'';
    const f=byId('contactSettingsForm');
    for(const key of ['controller_name','controller_address','privacy_email','retention_days','provider','from_email','smtp_host','smtp_port','smtp_user'])if(f.elements[key])f.elements[key].value=s[key]??'';
    f.elements.enabled.checked=s.enabled===true;
    f.elements.api_key.value='';f.elements.smtp_password.value='';
    byId('configurationStatus').textContent='Adatkezelés: '+(s.privacy_ready?'engedélyezve':'nincs engedélyezve')+' · Levélküldési adatok: '+(s.mail_ready?'megadva – tesztlevéllel ellenőrizhető':'hiányosak')+' · API-kulcs: '+(s.has_api_key?'mentve':'nincs')+' · SMTP-jelszó: '+(s.has_smtp_password?'mentve':'nincs');
    if(!s.encryption_ready)byId('configurationStatus').textContent+=' · A szerver tartós titkosítási kulcsa hiányzik.';
    if(!s.privacy_ready||!s.mail_ready)byId('settingsPanel').open=true;
  }
  async function loadList() {
    const status=byId('contactStatusFilter').value;
    const result=await api('inquiries?page='+page+'&status='+encodeURIComponent(status));pages=result.pages;
    byId('contactTotal').textContent=result.total+' megkeresés';byId('contactPage').textContent=page+' / '+pages+'. oldal';
    byId('previousContactPage').disabled=page<=1;byId('nextContactPage').disabled=page>=pages;
    byId('contactTable').innerHTML=result.items.length?'<table><thead><tr><th>Időpont</th><th>Szolgáltató</th><th>Jelentkező</th><th>Elérhetőség</th><th>Levél</th><th>Feldolgozás</th><th></th></tr></thead><tbody>'+result.items.map(x=>'<tr><td>'+esc(date(x.created_at))+'</td><td>'+esc(x.listing_name)+'</td><td>'+esc(x.name)+'</td><td>'+esc(x.email)+'<br>'+esc(x.phone||'–')+'</td><td><span class="status">'+esc(labels[x.delivery_status]||x.delivery_status)+'</span>'+(x.error_code?'<br><small>'+esc(x.error_code)+'</small>':'')+'</td><td>'+esc(labels[x.processing_status])+'</td><td><button data-detail="'+esc(x.id)+'">Részletek</button></td></tr>').join('')+'</tbody></table>':'<p>Még nincs ilyen állapotú megkeresés.</p>';
  }
  async function detail(id) {
    const d=await api('inquiries/'+encodeURIComponent(id));selected=d;const p=d.payload||{},box=byId('contactDetail');box.hidden=false;
    box.innerHTML='<h2>Megkeresés részletei</h2><p><code>'+esc(d.id)+'</code></p><dl><dt>Szolgáltató</dt><dd>'+esc(p.listing_name||'Törölt adat')+'</dd><dt>Jelentkező</dt><dd>'+esc(p.name||'Törölt adat')+'</dd><dt>E-mail</dt><dd>'+esc(p.email||'–')+'</dd><dt>Telefon</dt><dd>'+esc(p.phone||'–')+'</dd><dt>Küldési állapot</dt><dd>'+esc(labels[d.status]||d.status)+'</dd><dt>Rögzítés</dt><dd>'+esc(date(d.created_at))+'</dd><dt>Automatikus törlés</dt><dd>'+esc(date(d.expires_at))+'</dd></dl>'+(p.consent_text?'<h3>Rögzített hozzájárulás</h3><p>'+esc(date(d.consent_at))+' · '+esc(d.consent_version)+'</p><p class="consent-copy">'+esc(p.consent_text)+'</p>':'')+'<div class="toolbar"><button data-action="in_progress">Feldolgozás alatt</button><button data-action="closed">Lezárás</button>'+(['needs_mail','needs_recipient','failed','uncertain'].includes(d.status)?'<button data-action="retry">Küldés / újrapróbálás</button>':'')+(!['expired','sending'].includes(d.status)?'<button data-action="cancel">Küldés leállítása</button><button data-action="erase" class="danger">Személyes adatok törlése</button>':'')+'</div><h3>Eseménynapló</h3><table><thead><tr><th>Időpont</th><th>Esemény</th><th>Végrehajtó</th><th>Részlet</th></tr></thead><tbody>'+d.events.map(e=>'<tr><td>'+esc(date(e.created_at))+'</td><td>'+esc(labels[e.event_type]||e.event_type)+'</td><td>'+esc(e.actor)+'</td><td>'+esc(JSON.stringify(e.details||{}))+'</td></tr>').join('')+'</tbody></table><p id="detailMessage" role="status"></p>';
    box.scrollIntoView({behavior:'smooth',block:'start'});
  }
  byId('contactTable').addEventListener('click',e=>{const b=e.target.closest('[data-detail]');if(b)detail(b.dataset.detail).catch(showError);});
  function showError(e){byId('pageMessage').textContent=e.message;byId('pageMessage').className='contact-error';}
  byId('contactDetail').addEventListener('click',async e=>{
    const b=e.target.closest('[data-action]');if(!b||!selected)return;const action=b.dataset.action;
    if(action==='erase'&&!confirm('Végleg törlöd ennek a megkeresésnek a személyes adatait? A már elküldött levelet ez nem hívja vissza.'))return;
    let risk=false;
    if(action==='retry'&&selected.status==='uncertain'){risk=confirm('A korábbi küldés eredménye bizonytalan. Újrapróbáláskor a címzett ismét megkaphatja a levelet. Folytatod?');if(!risk)return;}
    b.disabled=true;try{await api('inquiries/'+selected.id+'/action',{method:'POST',body:JSON.stringify({action,confirm_duplicate_risk:risk})});await loadList();await detail(selected.id);}catch(error){byId('detailMessage').textContent=error.message;b.disabled=false;}
  });
  byId('contactSettingsForm').addEventListener('submit',async e=>{
    e.preventDefault();const f=e.currentTarget;if(!f.reportValidity())return;const b=f.querySelector('[type=submit]');b.disabled=true;
    const values=Object.fromEntries(new FormData(f).entries());values.enabled=f.elements.enabled.checked;values.retention_days=Number(values.retention_days);values.smtp_port=Number(values.smtp_port);
    try{await api('settings',{method:'PUT',body:JSON.stringify(values)});await loadSettings();byId('settingsMessage').textContent='Beállítások elmentve. A korábban várakozó megkereséseket külön tudod küldésre jelölni.';}catch(error){byId('settingsMessage').textContent=error.message;}finally{b.disabled=false;}
  });
  byId('testContactEmail').addEventListener('click',async e=>{e.target.disabled=true;byId('settingsMessage').textContent='Tesztlevél átadása…';try{const r=await api('test-email',{method:'POST',body:'{}'});byId('settingsMessage').textContent=r.message;}catch(error){byId('settingsMessage').textContent=error.message;}finally{e.target.disabled=false;}});
  byId('refreshContactList').addEventListener('click',()=>loadList().catch(showError));
  byId('contactStatusFilter').addEventListener('change',()=>{page=1;loadList().catch(showError);});
  byId('previousContactPage').addEventListener('click',()=>{if(page>1){page--;loadList().catch(showError);}});
  byId('nextContactPage').addEventListener('click',()=>{if(page<pages){page++;loadList().catch(showError);}});
  (async()=>{await loadSettings();byId('contactAdminBody').hidden=false;await loadList();})().catch(showError);
})();
