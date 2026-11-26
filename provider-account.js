/* Provider self-service. Credentials and email tokens stay out of browser storage. */
(() => {
 'use strict';
 const main=document.querySelector('[data-provider-page]');
 if(!main)return;
 const mode=main.dataset.providerPage;
 const byId=id=>document.getElementById(id);
 const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const fields=['name','kind','short_description','description','city','county','address','website_url','booking_url','email','phone','qualifications','specialties','languages','price_info'];
 let csrf='',session=null,profile=null,booting=false,profileBusy=false;
 let token=new URLSearchParams(window.location.hash.slice(1)).get('token')||'';
 if(token)history.replaceState(null,'',window.location.pathname+window.location.search);

 function showMessage(id,text,type='') {
  const element=byId(id);if(!element)return;
  element.textContent=text||'';
  element.className='provider-message'+(type?' is-'+type:'');
 }
 function busy(form,value) {
  if(!form)return;
  form.setAttribute('aria-busy',String(value));
  form.querySelectorAll('button[type="submit"]').forEach(button=>{button.disabled=value;});
 }
 async function api(path,{method='GET',data}={}) {
  const headers={Accept:'application/json'};
  if(method!=='GET'){headers['Content-Type']='application/json';headers['X-Provider-CSRF']=csrf;}
  let response;
  try{response=await fetch(path,{method,headers,credentials:'same-origin',cache:'no-store',referrerPolicy:'same-origin',signal:AbortSignal.timeout(20000),...(data===undefined?{}:{body:JSON.stringify(data)})});}
  catch(error){throw new Error(error.name==='TimeoutError'||error.name==='AbortError'?'A kérés túl sokáig tartott. Az adataid megmaradtak; próbáld újra.':'A kapcsolat megszakadt. Ellenőrizd az internetkapcsolatot, és próbáld újra.');}
  let result;
  try{result=await response.json();}catch{throw new Error('A szolgáltatás most nem válaszol megfelelően. Próbáld újra később.');}
  if(result.csrf_token)csrf=result.csrf_token;
  if(!response.ok){const error=new Error(result.error||'A művelet nem sikerült. Próbáld újra.');error.status=response.status;error.code=result.code;throw error;}
  return result;
 }
 function validForm(form) {
  form.querySelectorAll('input,textarea,select').forEach(input=>input.setCustomValidity(''));
  return form.reportValidity();
 }
 function validPasswords(form,passwordId,confirmationId) {
  const password=byId(passwordId),confirmation=byId(confirmationId);
  if(!validForm(form))return false;
  if(password.value.length<10)password.setCustomValidity('Legalább 10 karakteres jelszót adj meg.');
  else if(new TextEncoder().encode(password.value).length>72)password.setCustomValidity('Ez a jelszó túl hosszú. Válassz egy rövidebb, legalább 10 karakteres jelszót.');
  else if(password.value!==confirmation.value)confirmation.setCustomValidity('A két jelszó nem egyezik.');
  return form.reportValidity();
 }
 async function submit(form,handler,messageId='providerPageMessage') {
  if(form.getAttribute('aria-busy')==='true')return;
  busy(form,true);showMessage(messageId,'Feldolgozás…');
  try{await handler();}
  catch(error){showMessage(messageId,error.message,'error');}
  finally{busy(form,false);}
 }
 function updateHeader() {
  if(!session?.authenticated)return;
  document.querySelectorAll('.header-login,.mobile-menu a[href="/belepes"]').forEach(link=>{link.textContent='Fiókom';link.href='/fiokom';});
 }
 function showSignedIn() {
  const panel=byId('providerSignedIn');
  if(!panel)return;
  panel.hidden=false;byId('providerSignedInEmail').textContent=session.user?.email||'';
  const form=byId(mode==='login'?'providerLoginForm':'providerRegisterForm');if(form)form.hidden=true;
 }
 async function logout(button) {
  button.disabled=true;showMessage('providerPageMessage','Kijelentkezés…');
  try{await api('/api/provider/logout',{method:'POST',data:{}});window.location.assign('/belepes');}
  catch(error){showMessage('providerPageMessage',error.message,'error');button.disabled=false;}
 }
 function showTokenError(error) {
  showMessage('providerPageMessage',error.message||'A hivatkozás nem használható. Nyisd meg újra a levélben kapott linket.','error');
  const help=byId('providerTokenHelp');if(help)help.hidden=false;
  if(mode==='register'){
   byId('providerRegisterForm').hidden=false;
   byId('providerActivationForm').hidden=true;
  }
 }
 async function loadToken() {
  if(!token){showTokenError(new Error('A folytatáshoz nyisd meg az e-mailben kapott teljes hivatkozást.'));return;}
  if(mode==='register')byId('providerRegisterForm').hidden=true;
  const info=await api('/api/provider/token-info',{method:'POST',data:{token}});
  if(mode==='reset'){
   if(info.kind!=='reset')throw new Error('Ez a hivatkozás másik fiókművelethez tartozik. Nyisd meg a levélben szereplő teljes hivatkozást.');
   byId('providerResetEmail').textContent=info.email||'';byId('providerResetForm').hidden=false;busy(byId('providerResetForm'),false);
  }else{
   if(!['invite','setup'].includes(info.kind))throw new Error('Ez a hivatkozás jelszó-visszaállításhoz tartozik. Nyisd meg a levélben szereplő teljes hivatkozást.');
   byId('providerHeading').textContent=info.kind==='invite'?'Elfogadtuk a jelentkezésedet':'Fiókod aktiválása';
   byId('providerIntro').textContent=info.kind==='invite'?'Állíts be jelszót, majd töltsd ki a szolgáltatói adatlapodat.':'Állíts be jelszót, és készítsd elő a saját szolgáltatói adatlapodat.';
   byId('providerActivationEmail').value=info.email||'';
   byId('providerActivationName').value=info.display_name||'';
   byId('providerActivationForm').hidden=false;
   const notice=byId('providerInvitationNotice');notice.hidden=info.kind!=='invite';notice.textContent='A jelentkezésedet jóváhagytuk. A fiók aktiválása után kiválaszthatod a kategóriáidat és közzéteheted a kitöltött adatlapot.';
   busy(byId('providerActivationForm'),false);
  }
 }
 function categoryInputs() {return [...document.querySelectorAll('#providerCategoryChoices input[type="checkbox"]')];}
 function updateCategoryCount() {byId('providerCategoryCount').textContent=categoryInputs().filter(input=>input.checked).length+' / 5 kategória kiválasztva';}
 function renderCategories(categories,selected) {
  const chosen=new Set(selected||[]),groups=new Map();
  for(const category of categories||[]){const group=category.group_name||'Kategóriák';if(!groups.has(group))groups.set(group,[]);groups.get(group).push(category);}
  byId('providerCategoryChoices').innerHTML=[...groups].map(([name,items])=>'<section class="provider-category-group"><h3>'+esc(name)+'</h3><div class="provider-category-options">'+items.map(category=>'<label class="provider-check"><input name="category_slugs" type="checkbox" value="'+esc(category.slug)+'"'+(chosen.has(category.slug)?' checked':'')+'><span>'+esc(category.name)+'</span></label>').join('')+'</div></section>').join('');
  for(const input of categoryInputs())input.addEventListener('change',()=>{
   if(categoryInputs().filter(item=>item.checked).length>5){input.checked=false;showMessage('providerProfileMessage','Legfeljebb 5 kategóriát választhatsz.','error');}
   updateCategoryCount();
  });
  updateCategoryCount();
 }
 function renderProfile(result) {
  if(!result?.user||!Array.isArray(result.categories))throw new Error('Az adatlap most nem tölthető be. Próbáld újra.');
  profile=result;session.user=result.user;
  const listing=result.listing||{},form=byId('providerProfileForm');
  for(const key of fields){const input=form.elements.namedItem(key);if(input)input.value=listing[key]??(key==='kind'?'provider':key==='languages'?'Magyar':'');}
  form.elements.email.value=result.user.email||'';
  form.elements.online_available.checked=Boolean(listing.online_available);
  renderCategories(result.categories,listing.category_slugs);
  byId('providerAccountName').textContent=result.user.display_name||'Saját fiókod';
  byId('providerAccountEmail').textContent=result.user.email||'';
  const status=listing.status||'draft';
  byId('providerProfileStatus').textContent=({draft:'Piszkozat',pending:'Ellenőrzésre vár',published:'Nyilvános',rejected:'Átdolgozásra vár'})[status]||'Piszkozat';
  byId('providerApprovalStatus').textContent=result.user.approved
   ? (status==='published'?'Az adatlapod elérhető a katalógusban. A mentett változtatások a nyilvános adatlapon is megjelennek.':'A jelentkezésedet elfogadtuk. A megfelelően kitöltött adatlapot közzéteheted a katalógusban.')
   : result.submission_status==='rejected'?'A korábbi jelentkezést nem fogadtuk el. Ellenőrizd és pontosítsd az adatlapot, majd küldd be újra.'
   : ['new','reviewed'].includes(result.submission_status)||status==='pending'?'A jelentkezésed ellenőrzésre vár. Addig is pontosíthatod a bemutatkozásodat és az elérhetőségeidet.'
   :'Töltsd ki az adatlapot, majd küldd be ellenőrzésre. A nyilvános megjelenéshez elfogadott jelentkezés szükséges.';
  byId('providerPublish').hidden=!result.user.approved||status==='published';
  byId('providerSubmitReview').hidden=Boolean(result.user.approved);
  byId('providerUnpublish').hidden=status!=='published';
  form.querySelector('button[value="save"]').textContent=status==='draft'?'Piszkozat mentése':'Változtatások mentése';
  const link=byId('providerPublicLink'),expected=listing.slug?'/szolgaltato/'+encodeURIComponent(listing.slug):'';
  link.hidden=!(status==='published'&&expected&&listing.url===expected);
  if(!link.hidden)link.href=expected;
  byId('providerAccountBody').hidden=false;byId('providerAccountLoading').hidden=true;
 }
 function profilePayload(action) {
  const form=byId('providerProfileForm'),data={action};
  for(const key of fields)data[key]=form.elements.namedItem(key)?.value.trim()||'';
  data.online_available=form.elements.online_available.checked;
  data.category_slugs=categoryInputs().filter(input=>input.checked).map(input=>input.value);
  return data;
 }
 function validProfile(form,action) {
  if(!validForm(form))return false;
  if(['submit','publish'].includes(action)){
   const short=form.elements.short_description,description=form.elements.description,city=form.elements.city;
   if(short.value.trim().length<20){short.setCustomValidity('A rövid bemutatkozás legalább 20 karakter legyen.');return form.reportValidity();}
   if(description.value.trim().length<50){description.setCustomValidity('A részletes bemutatkozás legalább 50 karakter legyen.');return form.reportValidity();}
   if(!categoryInputs().some(input=>input.checked)){showMessage('providerProfileMessage','Válassz legalább egy, a tevékenységedhez illő kategóriát.','error');categoryInputs()[0]?.focus();return false;}
   if(!city.value.trim()&&!form.elements.online_available.checked){city.setCustomValidity('Adj meg települést, vagy jelöld be az online elérhetőséget.');return form.reportValidity();}
  }
  return true;
 }
 async function saveProfile(action) {
  const form=byId('providerProfileForm');
  if(profileBusy||!validProfile(form,action))return;
  profileBusy=true;busy(form,true);byId('providerUnpublish').disabled=true;showMessage('providerProfileMessage','Mentés…');
  try{const result=await api('/api/provider/profile',{method:'PUT',data:profilePayload(action)});renderProfile(result);showMessage('providerProfileMessage',result.message||'Az adatlapot elmentettük.','success');}
  catch(error){if(error.status===401){showMessage('providerProfileMessage','A munkameneted lejárt. Jelentkezz be újra; a még el nem mentett szöveget előbb másold ki.','error');}else showMessage('providerProfileMessage',error.message,'error');}
  finally{profileBusy=false;busy(form,false);byId('providerUnpublish').disabled=false;}
 }
 async function boot() {
  if(booting)return;booting=true;
  byId('providerRetry').hidden=true;showMessage('providerPageMessage','Betöltés…');
  main.querySelectorAll('[data-provider-submit]').forEach(button=>{button.disabled=true;});
  try{
   session=await api('/api/provider/session');
   if(!csrf)throw new Error('A fiókfelület nem tölthető be. Próbáld újra.');
   updateHeader();showMessage('providerPageMessage','');
   if(mode==='account'){
    if(!session.authenticated){window.location.replace('/belepes');return;}
    renderProfile(await api('/api/provider/profile'));
   }else if(mode==='reset'||mode==='register'&&token){
    try{await loadToken();}catch(error){showTokenError(error);}
   }else if(session.authenticated&&['login','register'].includes(mode)){showSignedIn();}
   else if(['register','forgot'].includes(mode)&&session.mail_ready===false){showMessage('providerPageMessage','A levélküldés beállítása folyamatban van. A kérésedet rögzítjük, és a hivatkozást a levélküldés elindulásakor kapod meg.');}
   else if(mode==='login'&&new URLSearchParams(window.location.search).get('jelszo')==='modositva'){showMessage('providerPageMessage','A jelszavad megváltozott. Jelentkezz be az új jelszóval.','success');}
   main.querySelectorAll('[data-provider-submit]').forEach(button=>{button.disabled=false;});
  }catch(error){showMessage('providerPageMessage',error.message,'error');byId('providerRetry').hidden=false;const loading=byId('providerAccountLoading');if(loading)loading.hidden=true;}
  finally{booting=false;}
 }

 main.querySelectorAll('[data-toggle-password]').forEach(button=>button.addEventListener('click',()=>{
  const input=byId(button.dataset.togglePassword),visible=input.type==='password';input.type=visible?'text':'password';button.textContent=visible?'Elrejtés':'Mutasd';button.setAttribute('aria-pressed',String(visible));button.setAttribute('aria-label',visible?'Jelszó elrejtése':'Jelszó megjelenítése');
 }));
 main.querySelectorAll('[data-provider-logout]').forEach(button=>button.addEventListener('click',()=>logout(button)));
 byId('providerRetry')?.addEventListener('click',boot);
 byId('providerLoginForm')?.addEventListener('submit',event=>{
  event.preventDefault();const form=event.currentTarget;if(!validForm(form))return;
  void submit(form,async()=>{await api('/api/provider/login',{method:'POST',data:{email:form.elements.email.value.trim(),password:form.elements.password.value}});form.elements.password.value='';window.location.assign('/fiokom');});
 });
 byId('providerRegisterForm')?.addEventListener('submit',event=>{
  event.preventDefault();const form=event.currentTarget;if(!validForm(form))return;
  void submit(form,async()=>{
   const result=await api('/api/provider/register',{method:'POST',data:{email:form.elements.email.value.trim(),display_name:form.elements.display_name.value.trim(),consent:form.elements.consent.checked}});
   showMessage('providerPageMessage','');form.hidden=true;
   const panel=byId('providerRegistrationResult');panel.hidden=false;panel.querySelector('h2').textContent=result.mail_ready===false?'A kérésedet rögzítettük':'Ellenőrizd a leveleidet';
   byId('providerRegistrationResultMessage').textContent=result.message||'A regisztrációs kérésedet rögzítettük. A fiók létrehozásához kövesd az e-mailben kapott hivatkozást.';
  });
 });
 byId('providerActivationForm')?.addEventListener('submit',event=>{
  event.preventDefault();const form=event.currentTarget;if(!validPasswords(form,'providerActivationPassword','providerActivationConfirm'))return;
  void submit(form,async()=>{await api('/api/provider/activate',{method:'POST',data:{token,password:form.elements.password.value,display_name:form.elements.display_name.value.trim(),consent:form.elements.consent.checked}});token='';form.elements.password.value='';form.elements.password_confirmation.value='';window.location.assign('/fiokom');});
 });
 byId('providerForgotForm')?.addEventListener('submit',event=>{
  event.preventDefault();const form=event.currentTarget;if(!validForm(form))return;
  void submit(form,async()=>{const result=await api('/api/provider/forgot-password',{method:'POST',data:{email:form.elements.email.value.trim()}});form.hidden=true;showMessage('providerPageMessage','');byId('providerForgotResult').hidden=false;byId('providerForgotResultMessage').textContent=result.message||'Ha ehhez az e-mail-címhez aktív fiók tartozik, elküldjük a jelszó-visszaállító hivatkozást.';});
 });
 byId('providerResetForm')?.addEventListener('submit',event=>{
  event.preventDefault();const form=event.currentTarget;if(!validPasswords(form,'providerResetPassword','providerResetConfirm'))return;
  void submit(form,async()=>{await api('/api/provider/reset-password',{method:'POST',data:{token,password:form.elements.password.value}});token='';form.reset();form.hidden=true;showMessage('providerPageMessage','');byId('providerResetResult').hidden=false;});
 });
 byId('providerProfileForm')?.addEventListener('submit',event=>{event.preventDefault();void saveProfile(event.submitter?.value||'save');});
 byId('providerUnpublish')?.addEventListener('click',()=>{void saveProfile('unpublish');});
 byId('providerChangePasswordForm')?.addEventListener('submit',event=>{
  event.preventDefault();const form=event.currentTarget;if(!validPasswords(form,'providerNewPassword','providerNewPasswordConfirm'))return;
  void submit(form,async()=>{await api('/api/provider/change-password',{method:'POST',data:{current_password:form.elements.current_password.value,password:form.elements.password.value}});form.reset();window.location.assign('/belepes?jelszo=modositva');},'providerPasswordMessage');
 });
 void boot();
})();
