const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
let cats=[];
const quickOrder=['pszichologusok','pszichiaterek','pszichoterapeutak','coachok','dietetikusok','par-es-csaladterapeutak','kepzesek','konferenciak-es-esemenyek'];
const iconMap={
  pszichologusok:'◌',pszichiaterek:'✚',pszichoterapeutak:'◎',coachok:'↗',
  dietetikusok:'◒','par-es-csaladterapeutak':'♡',kepzesek:'▤','konferenciak-es-esemenyek':'◫'
};

function fallbackCategories(){
  return [
    {slug:'pszichologusok',name:'Pszichológusok',group_name:'Szakmai segítség',icon:'◌',listing_count:0},
    {slug:'pszichiaterek',name:'Pszichiáterek',group_name:'Szakmai segítség',icon:'✚',listing_count:0},
    {slug:'pszichoterapeutak',name:'Pszichoterapeuták',group_name:'Szakmai segítség',icon:'◎',listing_count:0},
    {slug:'mentalhigienes-szakemberek',name:'Mentálhigiénés szakemberek',group_name:'Szakmai segítség',icon:'○',listing_count:0},
    {slug:'par-es-csaladterapeutak',name:'Pár- és családterapeuták',group_name:'Szakmai segítség',icon:'♡',listing_count:0},
    {slug:'coachok',name:'Coachok',group_name:'Fejlődés és életvezetés',icon:'↗',listing_count:0},
    {slug:'mediatorok',name:'Mediátorok',group_name:'Fejlődés és életvezetés',icon:'⇄',listing_count:0},
    {slug:'dietetikusok',name:'Dietetikusok',group_name:'Test és jóllét',icon:'◒',listing_count:0},
    {slug:'masszorok',name:'Masszőrök',group_name:'Test és jóllét',icon:'≈',listing_count:0},
    {slug:'fogaszatok',name:'Fogászatok',group_name:'Test és jóllét',icon:'◌',listing_count:0},
    {slug:'joga-es-mozgas',name:'Jóga és mozgás',group_name:'Test és jóllét',icon:'△',listing_count:0},
    {slug:'kineziologusok',name:'Kineziológusok',group_name:'Alternatív és spirituális',icon:'∞',listing_count:0},
    {slug:'asztrologusok',name:'Asztrológusok',group_name:'Alternatív és spirituális',icon:'✦',listing_count:0},
    {slug:'kepzesek',name:'Képzések',group_name:'Programok és tudás',icon:'▤',listing_count:0},
    {slug:'konferenciak-es-esemenyek',name:'Konferenciák és események',group_name:'Programok és tudás',icon:'◫',listing_count:0},
    {slug:'magazinok-es-portalok',name:'Magazinok és portálok',group_name:'Programok és tudás',icon:'▧',listing_count:0}
  ];
}

function renderCategories(data){
  cats=data;
  const cat=document.getElementById('cat');
  const submitCategory=document.getElementById('submitCategory');
  if(cat) cat.innerHTML='<option value="">Minden kategória</option>'+data.map(c=>'<option value="'+esc(c.slug)+'">'+esc(c.name)+'</option>').join('');
  if(submitCategory) submitCategory.innerHTML='<option value="">Kategória</option>'+data.map(c=>'<option value="'+esc(c.slug)+'">'+esc(c.name)+'</option>').join('');

  const bySlug=Object.fromEntries(data.map(c=>[c.slug,c]));
  const quick=quickOrder.map(s=>bySlug[s]).filter(Boolean);
  const quickBox=document.getElementById('quickCategories');
  if(quickBox){
    quickBox.innerHTML=quick.map(c=>'<a class="quick-category" href="/kategoria/'+encodeURIComponent(c.slug)+'"><span class="quick-icon">'+(iconMap[c.slug]||esc(c.icon)||'•')+'</span><strong>'+esc(c.name)+'</strong><small>'+(Number(c.listing_count)||0)+' találat</small></a>').join('');
  }

  const groups={};
  data.forEach(c=>(groups[c.group_name]??=[]).push(c));
  const groupBox=document.getElementById('categoryGroups');
  if(groupBox){
    groupBox.innerHTML=Object.entries(groups).map(([g,items])=>'<div class="category-group"><h3>'+esc(g)+'</h3><div class="category-link-list">'+items.map(c=>'<a href="/kategoria/'+encodeURIComponent(c.slug)+'"><span>'+esc(c.name)+'</span><b>'+(Number(c.listing_count)||0)+'</b></a>').join('')+'</div></div>').join('');
  }
}

async function loadCategories(){
  try{
    const r=await fetch('/api/public/categories',{headers:{Accept:'application/json'}});
    if(!r.ok) throw new Error('API '+r.status);
    const data=await r.json();
    renderCategories(Array.isArray(data)&&data.length?data:fallbackCategories());
  }catch(err){
    console.warn('Category API fallback:',err);
    renderCategories(fallbackCategories());
  }
}

async function loadFeatured(){
  try{
    const r=await fetch('/api/public/listings?limit=8',{headers:{Accept:'application/json'}});
    if(!r.ok) throw new Error('API '+r.status);
    const data=await r.json();
    if(!Array.isArray(data)||!data.length) return;
    const box=document.getElementById('featuredListings');
    if(!box)return;
    box.innerHTML=data.slice(0,4).map(x=>{
      const first=(x.categories&&x.categories[0])?x.categories[0].name:'Szolgáltató';
      const tags=(x.categories||[]).slice(0,2).map(c=>'<span>'+esc(c.name)+'</span>').join('');
      return '<a class="provider-card" href="'+esc(x.url||('#'))+'">'+
        '<div class="provider-top">'+(x.profile_image_url?'<img class="provider-avatar" src="'+esc(x.profile_image_url)+'" alt="">':'<div class="provider-avatar">'+esc((x.name||'M')[0])+'</div>')+
        '<div><h3>'+esc(x.name)+'</h3><p>'+esc(first)+'</p></div></div>'+
        '<div class="provider-tags">'+tags+(x.online_available?'<span>Online</span>':'')+'</div>'+
        '<div class="provider-location">⌖ '+esc(x.city||'Magyarország')+(x.verified?'<b>✓ Ellenőrzött</b>':'')+'</div>'+
      '</a>';
    }).join('');
  }catch(err){
    console.warn('Featured API unavailable:',err);
  }
}

const searchForm=document.getElementById('searchForm');
if(searchForm)searchForm.addEventListener('submit',e=>{
  e.preventDefault();
  const p=new URLSearchParams();
  const q=document.getElementById('q'),cat=document.getElementById('cat'),city=document.getElementById('city');
  if(q&&q.value)p.set('q',q.value);
  if(cat&&cat.value)p.set('category',cat.value);
  if(city&&city.value)p.set('city',city.value);
  location.href='/kereses?'+p.toString();
});

const submitForm=document.getElementById('submitForm');
if(submitForm)submitForm.addEventListener('submit',async e=>{
  e.preventDefault();
  const fd=new FormData(e.target),o=Object.fromEntries(fd.entries());
  o.online_available=fd.has('online_available');
  o.consent=fd.has('consent');
  const msg=document.getElementById('submitMsg');
  if(msg)msg.textContent='Küldés…';
  try{
    const r=await fetch('/api/directory/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Hiba történt');
    if(msg)msg.textContent=d.message;
    e.target.reset();
  }catch(err){
    if(msg)msg.textContent=err.message;
  }
});

loadCategories();
loadFeatured();