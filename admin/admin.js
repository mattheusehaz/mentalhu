const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
let articles=[],media=[],subscribers=[],currentView='articles';

async function api(url,opts={}){
  const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});
  if(r.status===401){showLogin();throw new Error('Nincs bejelentkezve.')}
  const ct=r.headers.get('content-type')||'';
  const data=ct.includes('application/json')?await r.json():await r.text();
  if(!r.ok) throw new Error(data.error||data||'Hiba történt');
  return data;
}
function showLogin(){ $('#loginView').hidden=false; $('#appView').hidden=true; }
function showApp(me){ $('#loginView').hidden=true; $('#appView').hidden=false; $('#userLabel').textContent=me.email||''; openView('articles'); refreshArticles(); }
function openView(name){
  currentView=name;
  const map={articles:'articlesView',editor:'editorView',media:'mediaView',subscribers:'subscribersView'};
  Object.values(map).forEach(id=>$('#'+id).hidden=true);
  $('#'+map[name]).hidden=false;
  $$('#appView section').forEach(()=>{});
  $$('.sidebar nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  $('#viewTitle').textContent={articles:'Cikkek',editor:'Cikk szerkesztése',media:'Képtár',subscribers:'Hírlevél'}[name];
  $('#newArticleBtn').hidden=name==='editor';
  if(name==='media') refreshMedia();
  if(name==='subscribers') refreshSubscribers();
}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}

$('#loginForm').addEventListener('submit',async e=>{
  e.preventDefault(); const msg=$('#loginMsg'); msg.textContent='Belépés…'; msg.className='msg';
  try{const d=await api('/api/admin/login',{method:'POST',body:JSON.stringify({email:$('#loginEmail').value,password:$('#loginPassword').value})}); msg.textContent=''; showApp(d)}
  catch(err){msg.textContent=err.message;msg.className='msg error'}
});
$('#logoutBtn').addEventListener('click',async()=>{try{await api('/api/admin/logout',{method:'POST'})}catch{}showLogin()});
$$('.sidebar nav button').forEach(b=>b.addEventListener('click',()=>openView(b.dataset.view)));
$('#newArticleBtn').addEventListener('click',()=>{resetEditor();openView('editor')});

async function refreshArticles(){
  articles=await api('/api/admin/articles'); renderArticles();
}
function renderArticles(){
  const q=$('#articleSearch').value.toLowerCase(), st=$('#statusFilter').value;
  const rows=articles.filter(a=>(!q||a.title.toLowerCase().includes(q)||a.category.toLowerCase().includes(q))&&(!st||a.status===st));
  $('#articleTable').innerHTML=`<table class="table"><thead><tr><th>CÍM</th><th>ROVAT</th><th>STÁTUSZ</th><th>FRISSÍTVE</th><th></th></tr></thead><tbody>${rows.map(a=>`<tr><td><a href="#" class="article-link" data-edit="${a.id}">${esc(a.title)}</a></td><td>${esc(a.category)}</td><td><span class="badge ${a.status}">${a.status==='published'?'Publikált':'Piszkozat'}</span></td><td>${new Date(a.updated_at).toLocaleString('hu-HU')}</td><td>${a.status==='published'?'<a target="_blank" href="/cikk/'+encodeURIComponent(a.slug)+'">Megnyitás ↗</a>':''}</td></tr>`).join('')}</tbody></table>`;
  $$('[data-edit]').forEach(x=>x.addEventListener('click',e=>{e.preventDefault();editArticle(x.dataset.edit)}));
}
$('#articleSearch').addEventListener('input',renderArticles); $('#statusFilter').addEventListener('change',renderArticles);

function resetEditor(){
  $('#articleForm').reset(); $('#articleId').value=''; $('#authorName').value='MENTÁL.hu'; $('#status').value='draft'; $('#heroPreview').style.backgroundImage=''; $('#heroPreview').textContent='Nincs kép'; $('#deleteArticleBtn').hidden=true; $('#editorMsg').textContent='';
}
async function editArticle(id){
  const a=await api('/api/admin/articles/'+id); openView('editor');
  $('#articleId').value=a.id; $('#title').value=a.title; $('#slug').value=a.slug; $('#category').value=a.category; $('#excerpt').value=a.excerpt||''; $('#contentHtml').value=a.content_html||''; $('#authorName').value=a.author_name||'MENTÁL.hu'; $('#heroImageId').value=a.hero_image_id||''; $('#heroImageAlt').value=a.hero_image_alt||''; $('#seoTitle').value=a.seo_title||''; $('#seoDescription').value=a.seo_description||''; $('#status').value=a.status; $('#featured').checked=!!a.featured; $('#deleteArticleBtn').hidden=false; updateHeroPreview();
}
function payload(){return{title:$('#title').value,slug:$('#slug').value,category:$('#category').value,excerpt:$('#excerpt').value,content_html:$('#contentHtml').value,author_name:$('#authorName').value,hero_image_id:$('#heroImageId').value||null,hero_image_alt:$('#heroImageAlt').value,status:$('#status').value,featured:$('#featured').checked,seo_title:$('#seoTitle').value,seo_description:$('#seoDescription').value}}
$('#articleForm').addEventListener('submit',async e=>{
  e.preventDefault(); const id=$('#articleId').value,msg=$('#editorMsg'); msg.textContent='Mentés…';msg.className='msg';
  try{const a=await api(id?'/api/admin/articles/'+id:'/api/admin/articles',{method:id?'PUT':'POST',body:JSON.stringify(payload())}); $('#articleId').value=a.id;$('#slug').value=a.slug;$('#deleteArticleBtn').hidden=false;msg.textContent='Mentve.';msg.className='msg ok';await refreshArticles()}catch(err){msg.textContent=err.message;msg.className='msg error'}
});
$('#deleteArticleBtn').addEventListener('click',async()=>{
  const id=$('#articleId').value;if(!id||!confirm('Biztosan törlöd ezt a cikket?'))return;
  await api('/api/admin/articles/'+id,{method:'DELETE'});resetEditor();openView('articles');refreshArticles();
});
$('#heroImageId').addEventListener('input',updateHeroPreview);
function updateHeroPreview(){const id=$('#heroImageId').value,p=$('#heroPreview');if(id){p.style.backgroundImage=`url('/media/${id}')`;p.textContent=''}else{p.style.backgroundImage='';p.textContent='Nincs kép'}}

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