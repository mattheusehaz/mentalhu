/* First-party, cookieless page counting. No browser storage or third-party requests. */
(() => {
 'use strict';
 const script=document.currentScript;
 const token=script?.dataset.token;
 if(!token || navigator.doNotTrack==='1' || window.doNotTrack==='1' || navigator.globalPrivacyControl===true)return;
 let sent=false;
 function record(){
  if(sent || document.visibilityState!=='visible' || document.prerendering)return;
  sent=true;
  const body=JSON.stringify({token});
  try{
   if(navigator.sendBeacon?.('/api/public/statistics/view',new Blob([body],{type:'application/json'})))return;
   fetch('/api/public/statistics/view',{method:'POST',headers:{'Content-Type':'application/json'},body,credentials:'same-origin',keepalive:true}).catch(()=>{});
  }catch(_){/* Analytics never interrupts reading. */}
 }
 if(document.prerendering)document.addEventListener('prerenderingchange',record,{once:true});
 document.addEventListener('visibilitychange',record);
 record();
})();
