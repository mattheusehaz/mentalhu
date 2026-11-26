const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
let articles=[],media=[],subscribers=[],listings=[],directoryCategories=[],submissions=[],currentView='listings';
let articleMetadata={hero_image_path:null,sources:[]}, savedArticleStatus='draft';
const submissionState={trash:false,page:1,pages:1,seq:0,controller:null,undo:null,busy:false,poll:null,timer:null};
const providerAccountState={page:1,pages:1,seq:0,controller:null,busy:false,timer:null};
let providerAdminCsrf='',providerAdminCsrfRequest=null;

async function api(url,opts={}){
  const r=await fetch(url,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})},credentials:'same-origin',referrerPolicy:'same-origin'});
  if(r.status===401){showLogin();throw new Error('Nincs bejelentkezve.')}
  const ct=r.headers.get('content-type')||'';
  const data=ct.includes('application/json')?await r.json():await r.text();
  if(!r.ok) {const error=new Error(data.error||data||'Hiba történt');error.status=r.status;error.code=data.code;throw error;}
  return data;
}
function showLogin(){ $('#loginView').hidden=false; $('#appView').hidden=true;providerAdminCsrf='';clearTimeout(submissionState.poll); }
function showApp(me){ $('#loginView').hidden=true; $('#appView').hidden=false; $('#userLabel').textContent=me.email||''; openView('listings'); refreshListings(); loadDirectoryCategories(); }
function openView(name){
  currentView=name;
  const map={listings:'listingsView',listingEditor:'listingEditorView',submissions:'submissionsView',providerAccounts:'providerAccountsView',articles:'articlesView',editor:'editorView',media:'mediaView',subscribers:'subscribersView'};
  Object.values(map).forEach(id=>$('#'+id).hidden=true);
  $('#'+map[name]).hidden=false;
  $$('#appView section').forEach(()=>{});
  $$('.sidebar nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===(name==='editor'?'articles':name)));
  $('#viewTitle').textContent={listings:'Szolgáltatók',listingEditor:'Szolgáltató szerkesztése',submissions:'Beküldések',providerAccounts:'Szolgáltatói fiókok',articles:'Cikkek',editor:'Cikk szerkesztése',media:'Képtár',subscribers:'Hírlevél'}[name];
  $('#newArticleBtn').hidden=!['listings','listingEditor','articles','editor'].includes(name);
  $('#newArticleBtn').textContent=['articles','editor'].includes(name)?'+ Új cikk':'+ Új szolgáltató';
  if(name==='media') refreshMedia();
  if(name==='subscribers') refreshSubscribers();
  if(name==='submissions') refreshSubmissions();
  else clearTimeout(submissionState.poll);
  if(name==='providerAccounts') refreshProviderAccounts();
  if(name==='articles') refreshArticles();
}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}

$('#loginForm').addEventListener('submit',async e=>{
  e.preventDefault(); const msg=$('#loginMsg'); msg.textContent='Belépés…'; msg.className='msg';
  try{const d=await api('/api/admin/login',{method:'POST',body:JSON.stringify({email:$('#loginEmail').value,password:$('#loginPassword').value})}); msg.textContent=''; showApp(d)}
  catch(err){msg.textContent=err.message;msg.className='msg error'}
});
$('#logoutBtn').addEventListener('click',async()=>{try{await api('/api/admin/logout',{method:'POST'})}catch{}showLogin()});
$$('.sidebar nav button').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.view==='listingEditor')resetListingEditor();openView(b.dataset.view)}));
$('#newArticleBtn').addEventListener('click',()=>{if(['articles','editor'].includes(currentView)){resetEditor();openView('editor')}else{resetListingEditor();openView('listingEditor')}});
$('#articleBackBtn').addEventListener('click',()=>openView('articles'));


async function loadDirectoryCategories(){
  directoryCategories=await api('/api/admin/directory/categories');
  const box=$('#categoryChecks'); if(!box)return;
  box.innerHTML=directoryCategories.map(c=>`<label style="display:flex;align-items:center;gap:7px;font-weight:400;margin:0"><input type="checkbox" data-cat="${esc(c.slug)}" style="width:auto"> ${esc(c.name)}</label>`).join('');
}
async function refreshListings(){ listings=await api('/api/admin/directory/listings'); renderListings(); }
function renderListings(){
  const q=($('#listingSearch')?.value||'').toLowerCase(),st=$('#listingStatusFilter')?.value||'';
  const rows=listings.filter(x=>(!q||x.name.toLowerCase().includes(q)||(x.city||'').toLowerCase().includes(q)||(x.category_slugs||[]).join(' ').toLowerCase().includes(q))&&(!st||x.status===st));
  $('#listingTable').innerHTML=`<table class="table"><thead><tr><th>NÉV</th><th>KATEGÓRIA</th><th>HELY</th><th>STÁTUSZ</th><th>ELLENŐRZÖTT</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td><a href="#" class="article-link" data-edit-listing="${x.id}">${esc(x.name)}</a></td><td>${esc((x.category_slugs||[]).join(', '))}</td><td>${esc(x.city||'')}</td><td><span class="badge ${x.status==='published'?'published':''}">${esc(x.status)}</span></td><td>${x.verified?'✓':''}</td><td>${x.status==='published'?'<a target="_blank" href="/szolgaltato/'+encodeURIComponent(x.slug)+'">Megnyitás ↗</a>':''}</td></tr>`).join('')}</tbody></table>`;
  $$('[data-edit-listing]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();editListing(a.dataset.editListing)}));
}
$('#listingSearch')?.addEventListener('input',renderListings); $('#listingStatusFilter')?.addEventListener('change',renderListings);

function resetListingEditor(){
  $('#listingForm').reset(); $('#listingId').value=''; $('#listingLanguages').value='Magyar'; $('#listingStatus').value='draft'; $('#deleteListingBtn').hidden=true; $('#listingMsg').textContent='';
  $$('[data-cat]').forEach(c=>c.checked=false);
}
async function editListing(id){
  if(!directoryCategories.length)await loadDirectoryCategories();
  const x=await api('/api/admin/directory/listings/'+id); openView('listingEditor');
  $('#listingId').value=x.id; $('#listingName').value=x.name||''; $('#listingSlug').value=x.slug||''; $('#listingKind').value=x.kind||'provider'; $('#listingStatus').value=x.status||'draft'; $('#listingShort').value=x.short_description||''; $('#listingDescription').value=x.description||''; $('#listingCity').value=x.city||''; $('#listingCounty').value=x.county||''; $('#listingAddress').value=x.address||''; $('#listingWebsite').value=x.website_url||''; $('#listingBooking').value=x.booking_url||''; $('#listingEmail').value=x.email||''; $('#listingPhone').value=x.phone||''; $('#listingQualifications').value=x.qualifications||''; $('#listingSpecialties').value=x.specialties||''; $('#listingPrice').value=x.price_info||''; $('#listingLanguages').value=x.languages||'Magyar'; $('#listingProfileImage').value=x.profile_image_id||''; $('#listingLogoImage').value=x.logo_image_id||''; $('#listingOnline').checked=!!x.online_available; $('#listingVerified').checked=!!x.verified; $('#listingFeatured').checked=!!x.featured; $('#listingNotes').value=x.admin_notes||''; $('#deleteListingBtn').hidden=false;
  const selected=new Set(x.category_slugs||[]); $$('[data-cat]').forEach(c=>c.checked=selected.has(c.dataset.cat));
}
function listingPayload(){return{name:$('#listingName').value,slug:$('#listingSlug').value,kind:$('#listingKind').value,status:$('#listingStatus').value,short_description:$('#listingShort').value,description:$('#listingDescription').value,city:$('#listingCity').value,county:$('#listingCounty').value,address:$('#listingAddress').value,website_url:$('#listingWebsite').value,booking_url:$('#listingBooking').value,email:$('#listingEmail').value,phone:$('#listingPhone').value,qualifications:$('#listingQualifications').value,specialties:$('#listingSpecialties').value,price_info:$('#listingPrice').value,languages:$('#listingLanguages').value,profile_image_id:$('#listingProfileImage').value||null,logo_image_id:$('#listingLogoImage').value||null,online_available:$('#listingOnline').checked,verified:$('#listingVerified').checked,featured:$('#listingFeatured').checked,admin_notes:$('#listingNotes').value,category_slugs:$$('[data-cat]').filter(c=>c.checked).map(c=>c.dataset.cat)}}
$('#listingForm')?.addEventListener('submit',async e=>{e.preventDefault();const id=$('#listingId').value,msg=$('#listingMsg');msg.textContent='Mentés…';msg.className='msg';try{const x=await api(id?'/api/admin/directory/listings/'+id:'/api/admin/directory/listings',{method:id?'PUT':'POST',body:JSON.stringify(listingPayload())});$('#listingId').value=x.id;$('#listingSlug').value=x.slug;$('#deleteListingBtn').hidden=false;msg.textContent='Mentve.';msg.className='msg ok';await refreshListings()}catch(err){msg.textContent=err.message;msg.className='msg error'}});
$('#deleteListingBtn')?.addEventListener('click',async()=>{const id=$('#listingId').value;if(!id||!confirm('Biztosan törlöd ezt a szolgáltatót?'))return;await api('/api/admin/directory/listings/'+id,{method:'DELETE'});resetListingEditor();openView('listings');refreshListings()});

async function ensureProviderAdminCsrf(){
  if(providerAdminCsrf)return providerAdminCsrf;
  if(!providerAdminCsrfRequest)providerAdminCsrfRequest=api('/api/admin/directory/submissions/session').then(data=>{
    if(typeof data.csrf_token!=='string'||!data.csrf_token)throw new Error('Az űrlap nem tölthető be. Frissítsd az oldalt.');
    providerAdminCsrf=data.csrf_token;return providerAdminCsrf;
  }).finally(()=>{providerAdminCsrfRequest=null;});
  return providerAdminCsrfRequest;
}
const submissionStatusNames={new:'Új',reviewed:'Átnézve',accepted:'Elfogadva',rejected:'Elutasítva'};
const invitationStatusNames={needs_mail:'Levélküldés beállítására vár',queued:'Értesítés küldésre vár',sending:'Értesítés küldése folyamatban',accepted:'A levélküldő átvette az értesítést',failed:'A levélküldés sikertelen',uncertain:'Bizonytalan küldési eredmény',cancelled:'Meghívó visszavonva'};
const submissionDate=value=>{const d=new Date(value);return Number.isNaN(d.valueOf())?'':new Intl.DateTimeFormat('hu-HU',{timeZone:'Europe/Budapest',dateStyle:'medium',timeStyle:'short'}).format(d);};
function submissionWebsite(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:'';}catch{return '';}}
function submissionNotice(message,undoId=null){
  $('#submissionNoticeText').textContent=message;$('#submissionNotice').hidden=!message;submissionState.undo=undoId;$('#submissionUndo').hidden=!undoId;
}
function renderSubmissions(data){
  if(!Array.isArray(data.items)||!Number.isFinite(Number(data.total)))throw new Error('A jelentkezések válasza hiányos.');
  submissions=data.items;submissionState.page=data.page;submissionState.pages=data.pages;
  $('#submissionHeading').textContent=submissionState.trash?'Kukába helyezett jelentkezések':'Beérkezett szolgáltatói jelentkezések';
  $('#submissionIntro').textContent=submissionState.trash?'A kukában lévő jelentkezések bármikor visszaállíthatók. A már létrehozott szolgáltatói fiókokat a kukába helyezés nem törli.':'Az elfogadás e-mailes meghívót indít a jelentkező saját szolgáltatói fiókjához.';
  $('#submissionTrashToggle').setAttribute('aria-pressed',String(submissionState.trash));
  $('#submissionTrashLabel').textContent=submissionState.trash?'Beküldések ('+data.active_count+')':'Kuka ('+data.trash_count+')';
  $('#submissionCount').textContent=data.total+' '+(submissionState.trash?'jelentkezés a kukában':'jelentkezés')+($('#submissionSearch').value.trim()||$('#submissionStatusFilter').value?' a szűrés szerint':'');
  $('#submissionPage').textContent=data.page+' / '+data.pages+'. oldal';
  $('#submissionPrevious').disabled=submissionState.busy||data.page<=1;$('#submissionNext').disabled=submissionState.busy||data.page>=data.pages;
  if(!submissions.length){$('#submissionTable').innerHTML='<p class="submission-empty">'+(submissionState.trash?'A kuka üres, vagy nincs a szűrésnek megfelelő jelentkezés.':'Nincs a szűrésnek megfelelő jelentkezés.')+'</p>';return;}
  const button=(x,action,text,extra='')=>'<button type="button" data-sub-id="'+esc(x.id)+'" data-sub-action="'+action+'" '+extra+(submissionState.busy?' disabled':'')+'>'+text+'</button>';
  $('#submissionTable').innerHTML='<table class="table submission-table"><thead><tr><th scope="col">Jelentkezés</th><th scope="col">Kapcsolat és kategória</th><th scope="col">Státusz és értesítés</th><th scope="col">Műveletek</th></tr></thead><tbody>'+submissions.map(x=>{
    const website=submissionWebsite(x.website_url);
    const details=[x.contact_name?'Kapcsolattartó: '+x.contact_name:'',x.description||'',x.qualifications?'Képesítések: '+x.qualifications:''].filter(Boolean).join('\n\n');
    const mailText=x.mail_status?(x.mail_kind==='invite'&&x.mail_expires_at&&new Date(x.mail_expires_at)<new Date()&&!x.account_activated?'A meghívó lejárt; új meghívó küldhető.':invitationStatusNames[x.mail_status]||'Értesítés állapota: '+x.mail_status):x.status==='accepted'?'Ehhez a korábbi elfogadáshoz még nincs értesítés.':'';
    const mailWarning=['needs_mail','failed','uncertain','cancelled'].includes(x.mail_status);
    let actions=submissionState.trash?button(x,'restore','Visszaállítás','class="primary"'):
      button(x,'review','Átnézve',x.status==='reviewed'?'disabled':'')+button(x,'accept','Elfogadva','class="primary"'+(x.status==='accepted'?' disabled':''))+button(x,'reject','Elutasítva',x.status==='rejected'?'disabled':'')+button(x,'trash','Kukába','class="danger"');
    if(!submissionState.trash&&x.status==='accepted')actions+=button(x,'invite',(x.account_activated?'Értesítés':'Meghívó')+(x.mail_status?' újraküldése':' küldése'),'class="submission-invite"'+(['queued','sending'].includes(x.mail_status)?' disabled':''));
    return '<tr data-submission-id="'+esc(x.id)+'"><td><strong class="submission-name">'+esc(x.name)+'</strong><small>'+esc(submissionState.trash?'Kukába helyezve: '+submissionDate(x.deleted_at):submissionDate(x.created_at))+'</small>'+((details||website)?'<details><summary>Jelentkezés részletei</summary><p>'+esc(details)+'</p>'+(website?'<a href="'+esc(website)+'" target="_blank" rel="noopener noreferrer">Megadott weboldal</a>':'')+'</details>':'')+'</td><td>'+esc(x.email)+'<small>'+esc(x.phone||'')+'</small><small>'+esc(x.category_slugs||'')+'</small><small>'+esc([x.city,x.online_available?'Online is elérhető':''].filter(Boolean).join(' · '))+'</small></td><td><span class="badge '+(x.status==='accepted'?'published':'')+'">'+esc(submissionStatusNames[x.status]||x.status)+'</span>'+(x.account_activated?'<div class="submission-account">Szolgáltatói fiók létrehozva</div>':'')+(mailText?'<div class="submission-mail '+(mailWarning?'warning':'')+'">'+esc(mailText)+'</div>':'')+(x.mail_status==='needs_mail'?'<small><a href="/admin/kapcsolatfelvetelek.html">Levélküldés beállításai</a></small>':'')+'</td><td><div class="submission-actions">'+actions+'</div></td></tr>';
  }).join('')+'</tbody></table>';
}
async function refreshSubmissions({quiet=false}={}){
  clearTimeout(submissionState.poll);const seq=++submissionState.seq;
  submissionState.controller?.abort();submissionState.controller=new AbortController();
  const message=$('#submissionMessage');message.className='msg';if(!quiet)message.textContent='Betöltés…';$('#submissionTable').setAttribute('aria-busy','true');
  try{
    await ensureProviderAdminCsrf();
    const query=new URLSearchParams({paginated:'true',trash:String(submissionState.trash),page:String(submissionState.page),page_size:'25',q:$('#submissionSearch').value.trim(),status:$('#submissionStatusFilter').value});
    const data=await api('/api/admin/directory/submissions?'+query,{signal:submissionState.controller.signal});
    if(seq!==submissionState.seq)return;
    renderSubmissions(data);message.textContent='';
    if(currentView==='submissions'&&submissions.some(x=>['queued','sending'].includes(x.mail_status)))submissionState.poll=setTimeout(()=>{if(currentView==='submissions'&&!submissionState.busy)refreshSubmissions({quiet:true});},5000);
  }catch(error){if(error.name==='AbortError'||seq!==submissionState.seq)return;message.textContent=error.message;message.className='msg error';}
  finally{if(seq===submissionState.seq)$('#submissionTable').setAttribute('aria-busy','false');}
}
async function submissionAction(id,action){
  if(submissionState.busy)return;
  submissionState.busy=true;clearTimeout(submissionState.poll);$$('#submissionsView button').forEach(button=>button.disabled=true);
  const message=$('#submissionMessage');message.className='msg';message.textContent='Mentés…';
  try{
    const token=await ensureProviderAdminCsrf(),status={accept:'accepted',review:'reviewed',reject:'rejected'}[action];
    const result=await api('/api/admin/directory/submissions/'+encodeURIComponent(id)+(status?'':'/'+(action==='invite'?'invitation':action)),{method:status?'PUT':'POST',headers:{'X-Provider-CSRF':token},body:JSON.stringify(status?{status}:{})});
    submissionNotice(result.message||'A műveletet elmentettük.',action==='trash'?id:null);
    submissionState.busy=false;await refreshSubmissions();
  }catch(error){if(error.status===403)providerAdminCsrf='';message.textContent=error.message;message.className='msg error';}
  finally{submissionState.busy=false;$$('#submissionsView button').forEach(button=>button.disabled=false);$('#submissionPrevious').disabled=submissionState.page<=1;$('#submissionNext').disabled=submissionState.page>=submissionState.pages;$$('#submissionTable [data-sub-action]').forEach(button=>{const row=submissions.find(x=>String(x.id)===button.dataset.subId);if(!row)return;button.disabled=(button.dataset.subAction==='accept'&&row.status==='accepted')||(button.dataset.subAction==='review'&&row.status==='reviewed')||(button.dataset.subAction==='reject'&&row.status==='rejected')||(button.dataset.subAction==='invite'&&['queued','sending'].includes(row.mail_status));});}
}
$('#submissionTable')?.addEventListener('click',event=>{const button=event.target.closest('[data-sub-action]');if(button)submissionAction(button.dataset.subId,button.dataset.subAction);});
$('#submissionTrashToggle')?.addEventListener('click',()=>{submissionState.trash=!submissionState.trash;submissionState.page=1;refreshSubmissions();});
$('#submissionUndo')?.addEventListener('click',()=>{if(submissionState.undo)submissionAction(submissionState.undo,'restore');});
$('#submissionSearchForm')?.addEventListener('submit',event=>{event.preventDefault();clearTimeout(submissionState.timer);submissionState.page=1;refreshSubmissions();});
$('#submissionSearch')?.addEventListener('input',()=>{clearTimeout(submissionState.timer);submissionState.timer=setTimeout(()=>{submissionState.page=1;refreshSubmissions();},300);});
$('#submissionStatusFilter')?.addEventListener('change',()=>{submissionState.page=1;refreshSubmissions();});
$('#submissionRefresh')?.addEventListener('click',()=>refreshSubmissions());
$('#submissionPrevious')?.addEventListener('click',()=>{if(submissionState.page>1){submissionState.page--;refreshSubmissions();}});
$('#submissionNext')?.addEventListener('click',()=>{if(submissionState.page<submissionState.pages){submissionState.page++;refreshSubmissions();}});

async function refreshProviderAccounts(){
  const seq=++providerAccountState.seq;providerAccountState.controller?.abort();providerAccountState.controller=new AbortController();
  const message=$('#providerAccountMessage');message.textContent='Betöltés…';message.className='msg';$('#providerAccountTable').setAttribute('aria-busy','true');
  try{
    await ensureProviderAdminCsrf();const data=await api('/api/admin/provider-accounts?'+new URLSearchParams({paginated:'true',q:$('#providerAccountSearch').value.trim(),page:String(providerAccountState.page),page_size:'25'}),{signal:providerAccountState.controller.signal});
    if(seq!==providerAccountState.seq)return;if(!Array.isArray(data.items))throw new Error('A szolgáltatói fiókok nem tölthetők be.');
    providerAccountState.page=data.page;providerAccountState.pages=data.pages;
    $('#providerAccountCount').textContent=data.total+' szolgáltatói fiók';$('#providerAccountPage').textContent=data.page+' / '+data.pages+'. oldal';
    $('#providerAccountTable').innerHTML=data.items.length?'<table class="table submission-table"><thead><tr><th scope="col">Fiók</th><th scope="col">Állapot</th><th scope="col">Adatlap</th><th scope="col">Művelet</th></tr></thead><tbody>'+data.items.map(x=>{
      const listing=x.listing,canOpen=listing&&typeof listing.url==='string'&&/^\/szolgaltato\/[^/?#]+$/.test(listing.url);
      return '<tr data-provider-account-id="'+esc(x.id)+'"><td><strong class="submission-name">'+esc(x.display_name||'Szolgáltatói fiók')+'</strong>'+esc(x.email)+'<small>'+esc(submissionDate(x.created_at))+'</small></td><td><span class="badge '+(x.approved&&!x.disabled?'published':'')+'">'+(x.disabled?'Felfüggesztve':x.approved?'Jóváhagyva':'Jóváhagyásra vár')+'</span><small>'+(x.email_verified?'E-mail-cím megerősítve':'E-mail-megerősítésre vár')+'</small></td><td>'+(listing?(canOpen?'<a href="'+esc(listing.url)+'" target="_blank" rel="noopener">'+esc(listing.name)+'</a>':esc(listing.name))+'<small>'+esc({draft:'Piszkozat',pending:'Ellenőrzésre vár',published:'Publikált',rejected:'Elutasítva'}[listing.status]||listing.status)+'</small>':'Még nincs adatlap')+'</td><td><button type="button" data-provider-account-action="'+(x.disabled?'enable':'disable')+'" data-provider-account-id="'+esc(x.id)+'" class="'+(x.disabled?'':'danger')+'">'+(x.disabled?'Újraengedélyezés':'Felfüggesztés')+'</button></td></tr>';
    }).join('')+'</tbody></table>':'<p class="submission-empty">Nincs a keresésnek megfelelő szolgáltatói fiók.</p>';
    message.textContent='';
  }catch(error){if(error.name!=='AbortError'&&seq===providerAccountState.seq){message.textContent=error.message;message.className='msg error';}}
  finally{if(seq===providerAccountState.seq){$('#providerAccountTable').setAttribute('aria-busy','false');$('#providerAccountPrevious').disabled=providerAccountState.page<=1;$('#providerAccountNext').disabled=providerAccountState.page>=providerAccountState.pages;}}
}
$('#providerAccountSearchForm')?.addEventListener('submit',event=>{event.preventDefault();clearTimeout(providerAccountState.timer);providerAccountState.page=1;refreshProviderAccounts();});
$('#providerAccountSearch')?.addEventListener('input',()=>{clearTimeout(providerAccountState.timer);providerAccountState.timer=setTimeout(()=>{providerAccountState.page=1;refreshProviderAccounts();},300);});
$('#providerAccountRefresh')?.addEventListener('click',()=>refreshProviderAccounts());
$('#providerAccountPrevious')?.addEventListener('click',()=>{if(providerAccountState.page>1){providerAccountState.page--;refreshProviderAccounts();}});
$('#providerAccountNext')?.addEventListener('click',()=>{if(providerAccountState.page<providerAccountState.pages){providerAccountState.page++;refreshProviderAccounts();}});
$('#providerAccountTable')?.addEventListener('click',async event=>{
  const button=event.target.closest('button[data-provider-account-action]');if(!button||providerAccountState.busy)return;
  providerAccountState.busy=true;$$('#providerAccountsView button').forEach(b=>b.disabled=true);const message=$('#providerAccountMessage');message.className='msg';message.textContent='Mentés…';
  try{const token=await ensureProviderAdminCsrf(),action=button.dataset.providerAccountAction;await api('/api/admin/provider-accounts/'+encodeURIComponent(button.dataset.providerAccountId)+'/action',{method:'POST',headers:{'X-Provider-CSRF':token},body:JSON.stringify({action})});await refreshProviderAccounts();$('#providerAccountNotice').textContent=action==='disable'?'A fiókot felfüggesztettük, a munkameneteket lezártuk, az adatlapot levettük a nyilvános oldalról.':'A fiók újra használható. Az adatlap közzététele külön művelet.';}catch(error){if(error.status===403)providerAdminCsrf='';message.textContent=error.message;message.className='msg error';}finally{providerAccountState.busy=false;$$('#providerAccountsView button').forEach(b=>b.disabled=false);$('#providerAccountPrevious').disabled=providerAccountState.page<=1;$('#providerAccountNext').disabled=providerAccountState.page>=providerAccountState.pages;}
});

async function refreshArticles(){
  articles=await api('/api/admin/articles'); renderArticles();
}
function renderArticles(){
  const q=$('#articleSearch').value.toLowerCase(), st=$('#statusFilter').value;
  const rows=articles.filter(a=>(!q||a.title.toLowerCase().includes(q)||(a.category||'').toLowerCase().includes(q))&&(!st||a.status===st));
  $('#articleTable').innerHTML=`<table class="table"><thead><tr><th>CÍM</th><th>TÉMA</th><th>STÁTUSZ</th><th>FRISSÍTVE</th><th></th></tr></thead><tbody>${rows.map(a=>`<tr><td><a href="#" class="article-link" data-edit="${a.id}">${esc(a.title)}</a></td><td>${esc(a.category)}</td><td><span class="badge ${a.status==='published'?'published':''}">${a.status==='published'?'Publikált':'Piszkozat'}</span></td><td>${new Date(a.updated_at).toLocaleString('hu-HU')}</td><td>${a.status==='published'?'<a target="_blank" href="/cikk/'+encodeURIComponent(a.slug)+'">Megnyitás ↗</a>':''}</td></tr>`).join('')}</tbody></table>`;
  $$('[data-edit]').forEach(x=>x.addEventListener('click',e=>{e.preventDefault();editArticle(x.dataset.edit)}));
}
$('#articleSearch').addEventListener('input',renderArticles); $('#statusFilter').addEventListener('change',renderArticles);

function resetEditor(){
  articleMetadata={hero_image_path:null,sources:[]}; savedArticleStatus='draft';
  $('#articleForm').reset(); $('#category').value='Mentális egészség'; $('#articleId').value=''; $('#authorName').value='MENTÁL.hu'; $('#status').value='draft'; $('#deleteArticleBtn').hidden=true; $('#editorMsg').textContent=''; $('#editorMsg').className='msg';
  updateArticleLinks(); updateArticleStatus(); updateHeroPreview(); renderArticleSources();
}
async function editArticle(id){
  const a=await api('/api/admin/articles/'+encodeURIComponent(id)); openView('editor');
  articleMetadata={hero_image_path:a.hero_image_path||null,sources:Array.isArray(a.sources)?a.sources:[]}; savedArticleStatus=a.status||'draft';
  const category=a.category&&a.category!=='Kutatások'?a.category:'Mentális egészség';
  if(!Array.from($('#category').options).some(option=>option.value===category)){
    const option=document.createElement('option'); option.value=category; option.textContent=category; $('#category').append(option);
  }
  $('#articleId').value=a.id; $('#title').value=a.title; $('#slug').value=a.slug; $('#category').value=category; $('#excerpt').value=a.excerpt||''; $('#contentHtml').value=a.content_html||''; $('#authorName').value=a.author_name||'MENTÁL.hu'; $('#heroImageId').value=a.hero_image_id||''; $('#heroImageAlt').value=a.hero_image_alt||''; $('#seoTitle').value=a.seo_title||''; $('#seoDescription').value=a.seo_description||''; $('#status').value=a.status||'draft'; $('#featured').checked=!!a.featured; $('#deleteArticleBtn').hidden=false; $('#editorMsg').textContent=''; $('#editorMsg').className='msg';
  updateArticleLinks(); updateArticleStatus(); updateHeroPreview(); renderArticleSources();
}
function payload(){return{title:$('#title').value,slug:$('#slug').value,category:$('#category').value,excerpt:$('#excerpt').value,content_html:$('#contentHtml').value,author_name:$('#authorName').value,hero_image_id:$('#heroImageId').value||null,hero_image_path:articleMetadata.hero_image_path,hero_image_alt:$('#heroImageAlt').value,sources:articleMetadata.sources,status:$('#status').value,featured:$('#featured').checked,seo_title:$('#seoTitle').value,seo_description:$('#seoDescription').value}}
function updateArticleLinks(){
  const id=$('#articleId').value, link=$('#previewArticleLink'); link.hidden=!id;
  if(id)link.href='/api/admin/articles/'+encodeURIComponent(id)+'/preview'; else link.removeAttribute('href');
}
function updateArticleStatus(){
  const published=$('#status').value==='published';
  $('#articleSaveBtn').textContent=published?(savedArticleStatus==='published'?'Publikált cikk mentése':'Mentés és publikálás'):'Piszkozat mentése';
  $('#articleStatusNote').textContent=published?'Mentés után a cikk nyilvánosan olvasható lesz a Cikkek oldalon, és megjelenik a főoldal friss tartalmai között.':'A piszkozatot csak a bejelentkezett szerkesztők láthatják.';
}
$('#status').addEventListener('change',updateArticleStatus);
$('#articleForm').addEventListener('submit',async e=>{
  e.preventDefault(); const id=$('#articleId').value,msg=$('#editorMsg'),button=$('#articleSaveBtn'); if(button.disabled)return; button.disabled=true; msg.textContent='Mentés…';msg.className='msg';
  try{
    const a=await api(id?'/api/admin/articles/'+encodeURIComponent(id):'/api/admin/articles',{method:id?'PUT':'POST',body:JSON.stringify(payload())});
    $('#articleId').value=a.id; $('#slug').value=a.slug; $('#deleteArticleBtn').hidden=false; savedArticleStatus=a.status; $('#status').value=a.status;
    articleMetadata={hero_image_path:a.hero_image_path||null,sources:Array.isArray(a.sources)?a.sources:[]};
    updateArticleLinks(); updateArticleStatus(); updateHeroPreview(); renderArticleSources();
    msg.textContent=a.status==='published'?'A cikk publikálva. A Cikkek oldal és a főoldal automatikusan frissül.':'A piszkozat elmentve. A cikk még nem nyilvános.'; msg.className='msg ok';
    refreshArticles().catch(()=>{});
  }catch(err){msg.textContent=err.message;msg.className='msg error'}finally{button.disabled=false}
});
$('#deleteArticleBtn').addEventListener('click',async()=>{
  const id=$('#articleId').value;if(!id||!confirm('Biztosan törlöd ezt a cikket?'))return;
  await api('/api/admin/articles/'+encodeURIComponent(id),{method:'DELETE'});resetEditor();openView('articles');
});
function safeResourceUrl(value){
  if(typeof value!=='string'||!value.trim())return null;
  try{const url=new URL(value,location.origin);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null}catch{return null}
}
function renderArticleSources(){
  const list=$('#articleSources'); list.replaceChildren();
  for(const source of articleMetadata.sources){
    const url=safeResourceUrl(typeof source==='string'?source:source&&source.url); if(!url)continue;
    const li=document.createElement('li'),link=document.createElement('a'); link.href=url; link.target='_blank'; link.rel='noopener noreferrer'; link.textContent=typeof source==='object'&&(source.title||source.name)?source.title||source.name:url; li.append(link); list.append(li);
  }
  $('#articleSourcesSection').hidden=!list.children.length;
}
$('#heroImageId').addEventListener('input',updateHeroPreview);
function updateHeroPreview(){
  const id=$('#heroImageId').value,p=$('#heroPreview'),url=id&&/^\d+$/.test(id)?'/media/'+id:safeResourceUrl(articleMetadata.hero_image_path);
  p.style.backgroundImage=''; p.replaceChildren(); $('#heroImageHint').hidden=!!id||!articleMetadata.hero_image_path;
  if(url){const image=document.createElement('img'); image.src=url; image.alt=$('#heroImageAlt').value||'Borítókép előnézete'; image.addEventListener('error',()=>{p.textContent='A kép nem tölthető be.'},{once:true}); p.append(image)}else p.textContent='Nincs kép';
}

async function refreshMedia(){
  media=await api('/api/admin/media');
  $('#mediaGrid').innerHTML=media.map(m=>`<div class="media-card"><img src="${m.url}" alt="${esc(m.alt_text)}"><div class="meta"><strong>#${m.id}</strong> · ${esc(m.filename)}<br>${m.width}×${m.height}<button data-use-media="${m.id}">Használom borítóként</button></div></div>`).join('');
  $$('[data-use-media]').forEach(b=>b.addEventListener('click',()=>{$('#heroImageId').value=b.dataset.useMedia;updateHeroPreview();openView('editor')}));
}
$('#mediaForm').addEventListener('submit',async e=>{
  e.preventDefault();const msg=$('#mediaMsg'),fd=new FormData();fd.append('image',$('#imageFile').files[0]);fd.append('alt_text',$('#imageAlt').value);msg.textContent='Feltöltés…';msg.className='msg';
  try{const r=await fetch('/api/admin/media',{method:'POST',body:fd});const d=await r.json();if(!r.ok)throw new Error(d.error||'Hiba');msg.textContent='Feltöltve. Kép ID: '+d.id;msg.className='msg ok';$('#mediaForm').reset();refreshMedia()}catch(err){msg.textContent=err.message;msg.className='msg error'}
});

async function refreshSubscribers(){
  subscribers=await api('/api/admin/subscribers');$('#subscriberCount').textContent=subscribers.filter(s=>s.status==='active').length+' aktív feliratkozó';
  $('#subscriberTable').innerHTML=`<table class="table"><thead><tr><th>E-MAIL</th><th>STÁTUSZ</th><th>FORRÁS</th><th>FELIRATKOZÁS</th></tr></thead><tbody>${subscribers.map(s=>`<tr><td>${esc(s.email)}</td><td><span class="badge ${s.status==='active'?'published':''}">${s.status==='active'?'Aktív':'Leiratkozott'}</span></td><td>${esc(s.source)}</td><td>${new Date(s.consent_at).toLocaleString('hu-HU')}</td></tr>`).join('')}</tbody></table>`;
}

(async()=>{try{const me=await api('/api/admin/me');showApp(me)}catch{showLogin()}})();
