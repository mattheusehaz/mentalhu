'use strict';
// Read-only checks of the user's public app addresses. No authentication or DB access.
const bases=['https://mental.hu','https://www.mental.hu','https://hammerhead-app-t8i2l.ondigitalocean.app'];
(async()=>{
 await Promise.all(bases.map(async base=>{
  await Promise.all(['/health/ready','/api/public/listings?limit=3','/kereses','/'].map(async route=>{
   const record={base,route};
   try{
    const r=await fetch(base+route,{signal:AbortSignal.timeout(12000),headers:{Accept:'application/json,text/html'}});
    record.status=r.status;record.finalUrl=r.url;record.release=r.headers.get('x-mental-release');
    const body=await r.text();
    if((r.headers.get('content-type')||'').includes('application/json')){
     const data=JSON.parse(body);
     if(Array.isArray(data))record.returnedItems=data.length;
     else for(const key of ['ok','database','migrations','phase','code','categories','listings','total'])if(Object.hasOwn(data,key))record[key]=data[key];
    }else{
     record.title=(body.match(/<title>([^<]*)<\/title>/i)||[])[1]||null;
     record.catalogTotal=(body.match(/data-catalog-total="(\d+)"/)||body.match(/data-total="(\d+)"/)||[])[1]||null;
     record.visibleCards=(body.match(/class="listing-card/g)||[]).length;
     record.pageLinks=(body.match(/class="page-link/g)||[]).length;
     record.frontend=(body.match(/data-release="([^"]+)"/)||[])[1]||null;
    }
   }catch(e){record.error=e.cause?.code||e.name;}
   console.log(JSON.stringify(record));
  }));
 }));
})().catch(e=>{console.error(e.name);process.exitCode=1;});
