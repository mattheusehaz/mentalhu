(() => {
  'use strict';
  const page = document.querySelector('[data-newsletter-page]');
  const forms = [...document.querySelectorAll('[data-newsletter-form]')];
  if (!page && !forms.length) return;
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const token = page?.dataset.token || new URLSearchParams(location.hash.replace(/^#/, '')).get('token') || '';
  if(page){
    delete page.dataset.token;
    if(new URLSearchParams(location.hash.replace(/^#/, '')).has('token'))history.replaceState(null,'',location.pathname+location.search);
    window.addEventListener('hashchange',()=>{if(new URLSearchParams(location.hash.replace(/^#/, '')).has('token'))location.reload();});
  }
  let topicRequest;
  function notice(node, text, error = false, success = false) {
    if (!node) return;
    node.textContent = text; node.dataset.error = String(error);node.dataset.success = String(success);
    node.setAttribute('role',error?'alert':'status');
  }
  async function api(url, body) {
    const response = await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},credentials:'same-origin',referrerPolicy:'same-origin',...(body?{body:JSON.stringify(body)}:{})});
    const type=response.headers.get('content-type')||'';
    const data=type.includes('application/json')?await response.json():{};
    if(!response.ok)throw new Error(data.error || (response.status===429?'Túl sok kérés érkezett. Kérjük, próbáld újra később.':'A művelet most nem sikerült. Kérjük, próbáld újra.'));
    return data;
  }
  async function loadTopics(form,force=false) {
    const wrap=form.querySelector('[data-newsletter-topics]'),retry=form.querySelector('[data-newsletter-retry]');
    if(wrap.querySelector('input[name=topics]')&&!force)return;
    const submit=form.querySelector('[type=submit]');submit.disabled=true;retry.hidden=true;
    try{
      if(!topicRequest||force)topicRequest=api('/api/newsletter/topics').catch(error=>{topicRequest=null;throw error;});
      const data=await topicRequest;
      if(!Array.isArray(data.items)||!data.items.length)throw new Error('A témák most nem érhetők el.');
      wrap.innerHTML=data.items.map(item=>'<label class="newsletter-topic"><input type="checkbox" name="topics" value="'+escape(item.key)+'"><span>'+escape(item.label)+'</span></label>').join('');
      submit.disabled=false;
    }catch(error){wrap.textContent=error.message;retry.hidden=false;}
  }
  function selectedTopics(form){return [...form.querySelectorAll('input[name=topics]:checked')].map(input=>input.value);}
  function checkTopics(form){
    const first=form.querySelector('input[name=topics]');
    if(!first)return false;
    first.setCustomValidity(selectedTopics(form).length?'':'Válassz legalább egy témát.');
    if(!first.reportValidity())return false;
    return true;
  }
  forms.forEach(form=>{
    form.addEventListener('change',event=>{
      if(event.target.name!=='topics')return;
      if(event.target.checked){form.querySelectorAll('input[name=topics]').forEach(input=>{if(event.target.value==='all'&&input!==event.target||event.target.value!=='all'&&input.value==='all')input.checked=false;});}
      form.querySelector('input[name=topics]')?.setCustomValidity('');
    });
    form.querySelector('[data-newsletter-retry]')?.addEventListener('click',()=>void loadTopics(form,true));
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(form.dataset.busy==='true')return;
      const message=form.querySelector('[data-newsletter-message]');
      if(!checkTopics(form)){notice(message,'Válassz legalább egy témát.',true);return;}
      const preferences=form.dataset.newsletterMode==='preferences';
      const submit=form.querySelector('[type=submit]'),caption=submit.textContent;
      const data=new FormData(form);const payload={name:String(data.get('name')||'').trim(),topics:selectedTopics(form)};
      if(preferences)payload.token=token;else Object.assign(payload,{email:String(data.get('email')||'').trim(),consent:data.has('consent'),website:String(data.get('website')||'')});
      form.dataset.busy='true';submit.disabled=true;submit.textContent=preferences?'Mentés…':'Küldés…';notice(message,'');
      try{
        const result=await api(preferences?'/api/newsletter/preferences':'/api/newsletter/subscribe',payload);
        notice(message,result.message||(preferences?'A választásaidat elmentettük.':'Nézd meg a postaládádat, és erősítsd meg a feliratkozást az e-mailben.'),false,true);
        if(!preferences)form.reset();
        message.focus({preventScroll:true});
      }catch(error){notice(message,error.message,true);}
      finally{form.dataset.busy='false';submit.disabled=false;submit.textContent=caption;}
    });
    if(form.dataset.newsletterMode==='subscribe')void loadTopics(form);
  });
  if(!page)return;
  const mode=page.dataset.mode;
  if(mode==='preferences'){
    const form=page.querySelector('[data-newsletter-form]');
    const message=page.querySelector('[data-newsletter-page-message]');
    const loading=page.querySelector('[data-newsletter-preferences-loading]');
    void (async()=>{
      try{
        if(!token)throw new Error('A beállítási hivatkozás hiányos. Nyisd meg a legutóbbi hírlevélben kapott hivatkozást.');
        const [,data]=await Promise.all([loadTopics(form),api('/api/newsletter/preferences/read',{token})]);
        if(!form.querySelector('input[name=topics]'))throw new Error('A témák nem tölthetők be. Frissítsd az oldalt.');
        form.elements.name.value=data.name||'';form.querySelector('[data-newsletter-email]').textContent=data.email||'';
        const selected=new Set(data.topics||[]);form.querySelectorAll('input[name=topics]').forEach(input=>{input.checked=selected.has(input.value);});
        page.querySelector('[data-newsletter-unsubscribe-link]').href='/hirlevel/leiratkozas#token='+encodeURIComponent(token);
        page.querySelector('[data-newsletter-preferences-content]').hidden=false;
        if(data.status==='unsubscribed'){form.querySelector('[type=submit]').disabled=true;notice(form.querySelector('[data-newsletter-message]'),'Erről a címről már leiratkoztál. Új feliratkozást a Hírlevél oldalon indíthatsz.');}
      }catch(error){notice(message,error.message,true);}
      finally{loading.hidden=true;}
    })();
  }
  const action=page.querySelector('[data-newsletter-confirm],[data-newsletter-unsubscribe]');
  if(action){
    const message=page.querySelector('[data-newsletter-message]');
    if(!token){action.disabled=true;notice(message,'A hivatkozás hiányos. Nyisd meg újra a levélben kapott hivatkozást.',true);return;}
    action.addEventListener('click',async()=>{
      const caption=action.textContent;action.disabled=true;action.textContent='Feldolgozás…';notice(message,'');
      try{
        const result=await api(mode==='confirm'?'/api/newsletter/confirm':'/api/newsletter/unsubscribe',{token});
        notice(message,result.message||(mode==='confirm'?'Megerősítetted a feliratkozást. Várunk pénteken!':'Leiratkoztál a hírlevélről.'),false,true);
        action.hidden=true;
        const followup=page.querySelector('[data-newsletter-followup]');const link=document.createElement('a');
        link.textContent=mode==='confirm'&&result.preferences_token?'Témáim és beállításaim':'Vissza a magazinba';
        link.href=mode==='confirm'&&result.preferences_token?'/hirlevel/beallitasok#token='+encodeURIComponent(result.preferences_token):'/';
        followup.replaceChildren(link);followup.hidden=false;message.focus({preventScroll:true});
      }catch(error){notice(message,error.message,true);action.disabled=false;action.textContent=caption;}
    });
  }
})();
