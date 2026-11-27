(() => {
 'use strict';
 const panel=document.querySelector('[data-service-ratings]');
 if(!panel)return;
 const slug=panel.dataset.listingSlug;
 if(!/^[a-zA-Z0-9_-]+$/.test(slug||''))return;
 const query=selector=>panel.querySelector(selector);
 const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const endpoint='/api/ratings/'+encodeURIComponent(slug);
 let csrf='',identity=null,controller=null,generation=0,sessionGeneration=0,busy=false,current=null;
 function notice(text='',error=false){const node=query('[data-ratings-message]');node.textContent=text;node.dataset.error=String(error);node.setAttribute('role',error?'alert':'status');}
 function gate(message=''){
  current=null;csrf='';busy=false;controller?.abort();controller=null;generation++;
  query('[data-ratings-content]').replaceChildren();query('[data-ratings-content]').hidden=true;query('[data-ratings-guest]').hidden=false;query('[data-ratings-retry]').hidden=true;notice(message);
 }
 async function request(method='GET',body){
  const requestGeneration=generation,requestIdentity=identity;
  const response=await fetch(endpoint,{method,credentials:'same-origin',cache:'no-store',referrerPolicy:'same-origin',headers:{Accept:'application/json',...(method==='GET'?{}:{'Content-Type':'application/json','X-Account-CSRF':csrf})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller?.signal});
  const result=(response.headers.get('content-type')||'').includes('application/json')?await response.json():{};
  if(!response.ok){const error=new Error(result.error||'Az értékelések most nem érhetők el. Próbáld újra.');error.status=response.status;error.code=result.code;throw error;}
  if(result.csrf_token&&generation===requestGeneration&&identity===requestIdentity)csrf=result.csrf_token;
  return result;
 }
 function selection(){return Number(query('input[name="service_rating"]:checked')?.value)||null;}
 function updateSelection(){
  const value=selection();
  panel.querySelectorAll('[data-rating-star]').forEach(label=>label.dataset.filled=String(Number(label.dataset.ratingStar)<=value));
  const feedback=query('[data-rating-selection]');if(feedback)feedback.textContent=value?value+' csillagot választottál.':'Válassz egy csillagszámot.';
  const save=query('[data-rating-save]');if(save)save.disabled=busy||!value;
 }
 function render(result){
  current=result;
  const total=Number(result.count)||0,average=Number(result.average),mine=Number(result.my_rating?.score)||0;
  const displayAverage=total&&Number.isFinite(average)?average.toLocaleString('hu-HU',{minimumFractionDigits:1,maximumFractionDigits:1}):'';
  const aggregate=total?'<div class="service-ratings-average"><strong>'+escape(displayAverage)+'</strong><span>az elérhető 5 csillagból</span></div><p class="service-ratings-total">'+total.toLocaleString('hu-HU')+' olvasói értékelés alapján</p>':'<h3>Még nincs értékelés.</h3><p>Az első olvasói visszajelzés még várat magára.</p>';
  let form;
  if(result.can_rate){
   form='<form class="service-rating-form" data-rating-form><fieldset><legend>'+ (mine?'Saját értékelésed':'Milyen volt a tapasztalatod?')+'</legend><p class="service-rating-hint">A saját tapasztalatod alapján értékelj. Később módosíthatod vagy törölheted.</p><div class="service-rating-stars">'+[1,2,3,4,5].map(value=>'<label data-rating-star="'+value+'" data-filled="'+String(value<=mine)+'"><input type="radio" name="service_rating" value="'+value+'" aria-label="'+value+' csillag" required'+(value===mine?' checked':'')+'><span aria-hidden="true">★</span><small aria-hidden="true">'+value+'</small></label>').join('')+'</div><p class="service-rating-selection" data-rating-selection aria-live="polite"></p></fieldset><div class="service-rating-actions"><button class="button button-green" data-rating-save type="submit"'+(!mine?' disabled':'')+'>'+ (mine?'Értékelés módosítása':'Értékelés mentése')+'</button>'+(mine?'<button class="service-ratings-link" type="button" data-rating-delete>Értékelésem törlése</button>':'')+'</div></form>';
  }else form='<div class="service-rating-own"><h3>Saját szolgáltatói adatlap</h3><p>Az olvasói összesítést megnézheted, a saját adatlapodat azonban nem értékelheted.</p>'+(mine?'<button class="service-ratings-link" type="button" data-rating-delete>Korábbi értékelésem törlése</button>':'')+'</div>';
  query('[data-ratings-content]').innerHTML='<div class="service-ratings-grid"><div class="service-ratings-summary">'+aggregate+'</div><div>'+form+'</div></div>';
  query('[data-ratings-content]').hidden=false;query('[data-ratings-guest]').hidden=true;updateSelection();
 }
 async function load(){
  controller?.abort();controller=new AbortController();busy=false;const activeGeneration=++generation;query('[data-ratings-retry]').hidden=true;notice('Az értékelések betöltése…');
  try{const result=await request();if(generation===activeGeneration){render(result);notice('');}}
  catch(error){if(error.name==='AbortError'||generation!==activeGeneration)return;if(error.status===401||error.status===403){identity='guest';gate('A folytatáshoz jelentkezz be újra.');}else{notice(error.message,true);query('[data-ratings-retry]').hidden=false;}}
 }
 function applySession(session){
  const active=session?.authenticated===true&&session.user?.email_verified===true;
  const key=active?String(session.user?.id||session.user?.email||'account'):'guest';
  if(key===identity)return;
  identity=key;
  gate();
  if(!active)return;
  csrf=session.csrf_token||'';void load();
 }
 async function bootstrap(force=false){
  const checkGeneration=++sessionGeneration;
  if(force){identity=null;gate();}
  try{const session=window.MentalAccount?await window.MentalAccount.session(force):await fetch('/api/account/session',{credentials:'same-origin',cache:'no-store'}).then(response=>response.json());if(checkGeneration===sessionGeneration)applySession(session);}
  catch{if(checkGeneration!==sessionGeneration)return;identity=null;gate();notice('A fiók állapota most nem ellenőrizhető. Próbáld újra.',true);query('[data-ratings-retry]').hidden=false;}
 }
 panel.addEventListener('change',event=>{if(event.target.name==='service_rating')updateSelection();});
 panel.addEventListener('submit',async event=>{
  if(!event.target.matches('[data-rating-form]'))return;event.preventDefault();const score=selection();if(busy||!score||!csrf)return;
  const mutationGeneration=generation,mutationIdentity=identity;
  const isCurrent=()=>mutationGeneration===generation&&mutationIdentity===identity;
  busy=true;updateSelection();notice('Az értékelés mentése…');
  try{const result=await request('PUT',{score});if(!isCurrent())return;render(result);notice('Az értékelésedet elmentettük.');}
  catch(error){if(!isCurrent()||error.name==='AbortError')return;if(error.status===401){identity='guest';gate('A mentéshez jelentkezz be újra.');}else notice(error.message,true);}
  finally{if(isCurrent()){busy=false;updateSelection();}}
 });
 panel.addEventListener('click',async event=>{
  const button=event.target.closest('[data-rating-delete]');if(!button||busy||!csrf)return;
  const mutationGeneration=generation,mutationIdentity=identity;
  const isCurrent=()=>mutationGeneration===generation&&mutationIdentity===identity;
  busy=true;button.disabled=true;notice('Az értékelés törlése…');
  try{const result=await request('DELETE',{});if(!isCurrent())return;render(result);notice('Az értékelésedet töröltük.');}
  catch(error){if(!isCurrent()||error.name==='AbortError')return;if(error.status===401){identity='guest';gate('A folytatáshoz jelentkezz be újra.');}else{notice(error.message,true);button.disabled=false;}}
  finally{if(isCurrent()){busy=false;updateSelection();}}
 });
 query('[data-ratings-retry]').addEventListener('click',()=>void bootstrap(true));
 window.addEventListener('mental-account-change',event=>applySession(event.detail));
 window.addEventListener('pageshow',event=>{if(event.persisted){identity=null;gate();void bootstrap(true);}});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void bootstrap(true);});
 void bootstrap();
})();
