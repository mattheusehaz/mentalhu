const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
let articles=[],media=[],subscribers=[],listings=[],directoryCategories=[],submissions=[],currentView='listings';
let articleMetadata={hero_image_path:null,sources:[]}, savedArticleStatus='draft';

async function api(url,opts={}){
  const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});
  if(r.status===401){showLogin();throw new Error('Nincs bejelentkezve.')}
  const ct=r.headers.get('content-type')||'';
  const data=ct.includes('application/json')?await r.json():await r.text();
  if(!r.ok) throw new Error(data.error||data||'Hiba történt');
  return data;
}
function showLogin(){ $('#loginView').hidden=false; $('#appView').hidden=true; }
function showApp(me){ $('#loginView').hidden=true; $('#appView').hidden=false; $('#userLabel').textContent=me.email||''; openView('listings'); refreshListings(); loadDirectoryCategories(); }
function openView(name){
  currentView=name;
  const map={listings:'listingsView',listingEditor:'listingEditorView',submissions:'submissionsView',articles:'articlesView',editor:'editorView',media:'mediaView',subscribers:'subscribersView'};
  Object.values(map).forEach(id=>$('#'+id).hidden=true);
  $('#'+map[name]).hidden=false;
  $$('#appView section').forEach(()=>{});
  $$('.sidebar nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===(name==='editor'?'articles':name)));
  $('#viewTitle').textContent={listings:'Szolgáltatók',listingEditor:'Szolgáltató szerkesztése',submissions:'Beküldések',articles:'Cikkek',editor:'Cikk szerkesztése',media:'Képtár',subscribers:'Hírlevél'}[name];
  $('#newArticleBtn').hidden=!['listings','listingEditor','articles','editor'].includes(name);
  $('#newArticleBtn').textContent=['articles','editor'].includes(name)?'+ Új cikk':'+ Új szolgáltató';
  if(name==='media') refreshMedia();
  if(name==='subscribers') refreshSubscribers();
  if(name==='submissions') refreshSubmissions();
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

async function refreshSubmissions(){
  submissions=await api('/api/admin/directory/submissions');
  $('#submissionTable').innerHTML=`<table class="table"><thead><tr><th>NÉV</th><th>KAPCSOLAT</th><th>KATEGÓRIA</th><th>HELY</th><th>STÁTUSZ</th><th></th></tr></thead><tbody>${submissions.map(x=>`<tr><td><strong>${esc(x.name)}</strong><br><small>${esc(x.description||'')}</small></td><td>${esc(x.email)}<br>${esc(x.phone||'')}</td><td>${esc(x.category_slugs||'')}</td><td>${esc(x.city||'')}</td><td>${esc(x.status)}</td><td><button data-sub="${x.id}" data-status="reviewed">Átnézve</button> <button data-sub="${x.id}" data-status="accepted">Elfogadva</button> <button data-sub="${x.id}" data-status="rejected">Elutasítva</button></td></tr>`).join('')}</tbody></table>`;
  $$('[data-sub]').forEach(b=>b.addEventListener('click',async()=>{await api('/api/admin/directory/submissions/'+b.dataset.sub,{method:'PUT',body:JSON.stringify({status:b.dataset.status})});refreshSubmissions()}));
}

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