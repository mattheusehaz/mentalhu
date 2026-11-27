'use strict';

const crypto = require('node:crypto');
const slugify = require('slugify');
const {publicUser} = require('./provider-accounts.cjs');
const LIMITS = Object.freeze({name:200,short_description:500,description:10000,city:120,county:120,address:400,website_url:500,booking_url:500,email:254,phone:40,qualifications:3000,specialties:2000,languages:250,price_info:500});
const FIELDS = [...Object.keys(LIMITS),'kind','online_available'];
const ACTIONS = new Set(['save','submit','publish','unpublish']);
const fail = (code,message,httpStatus=400) => Object.assign(new Error(message),{code,httpStatus});
const defaults = () => Object.fromEntries(FIELDS.map(key=>[key,key==='kind'?'provider':key==='online_available'?false:key==='languages'?'Magyar':'']));

function cleanProfile(body,previous,user) {
  if (!body || typeof body!=='object' || Array.isArray(body)) throw fail('INVALID_PROFILE','Érvénytelen adatlap.');
  const allowed=new Set([...FIELDS,'category_slugs','action']);
  for(const key of Object.keys(body)) if(!allowed.has(key)) throw fail('FIELD_NOT_ALLOWED','Ez a mező nem módosítható: '+key.slice(0,40));
  const values={...defaults(),...Object.fromEntries(FIELDS.filter(key=>previous?.[key]!==undefined).map(key=>[key,previous[key]]))};
  for(const [key,max] of Object.entries(LIMITS)) if(Object.hasOwn(body,key)) {
    if(typeof body[key]!=='string'||body[key].length>max||/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(body[key]))throw fail('INVALID_FIELD','Ellenőrizd ezt a mezőt: '+key+'.');
    values[key]=body[key].trim();
  }
  if(values.name.length<2)throw fail('NAME_REQUIRED','Legalább két karakteres nevet adj meg.');
  if(Object.hasOwn(body,'kind'))values.kind=body.kind;
  if(!['provider','organization'].includes(values.kind))throw fail('INVALID_KIND','Válassz szakembert vagy szervezetet.');
  if(Object.hasOwn(body,'online_available')) {
    if(typeof body.online_available!=='boolean')throw fail('INVALID_FIELD','Ellenőrizd az online elérhetőséget.');
    values.online_available=body.online_available;
  }
  for(const key of ['website_url','booking_url']) if(values[key]) {
    let url;try{url=new URL(values[key]);}catch{throw fail('INVALID_URL','Teljes http:// vagy https:// webcímet adj meg.');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||/[\s\r\n]/.test(values[key]))throw fail('INVALID_URL','Csak nyilvános http:// vagy https:// webcím adható meg.');
  }
  // Contact requests may only go to the address confirmed by the account owner.
  if(Object.hasOwn(body,'email')&&body.email.trim().toLowerCase()!==user.email)throw fail('EMAIL_NOT_VERIFIED','A kapcsolatfelvételi cím a fiókodhoz megerősített e-mail-cím.');
  values.email=user.email;
  const categories=Object.hasOwn(body,'category_slugs')?body.category_slugs:previous?.category_slugs||[];
  if(!Array.isArray(categories)||categories.length>5||categories.some(x=>typeof x!=='string'||!/^[a-z0-9-]{1,120}$/.test(x))||new Set(categories).size!==categories.length)throw fail('INVALID_CATEGORIES','Legfeljebb öt különböző kategóriát válassz.');
  const action=body.action||'save';if(!ACTIONS.has(action))throw fail('INVALID_ACTION','Ismeretlen művelet.');
  if(action==='submit'||action==='publish'||(action==='save'&&previous?.status==='published')) {
    if(values.short_description.length<20||values.description.length<50||!categories.length||(!values.city&&!values.online_available))throw fail('INCOMPLETE_PROFILE','A beküldéshez adj meg rövid bemutatkozást (legalább 20 karakter), részletes leírást (legalább 50 karakter), kategóriát és települést vagy online elérhetőséget.');
  }
  if(action==='publish'&&!user.approved)throw fail('APPROVAL_REQUIRED','Az adatlap közzétételéhez előbb el kell fogadnunk a jelentkezésedet.',403);
  return {values,categories,action};
}

function listingPublic(row) {
  if(!row)return null;
  return {id:row.id,slug:row.slug||null,status:row.status,...Object.fromEntries(FIELDS.map(key=>[key,row[key]])),category_slugs:row.category_slugs||[],url:row.slug?'/szolgaltato/'+encodeURIComponent(row.slug):null};
}

function createProviderProfileService({pool,dbState,auth,accounts,audit=()=>{}}) {
  const privateHeaders=(req,res,next)=>{res.set('Cache-Control','private, no-store');res.set('X-Robots-Tag','noindex, nofollow');next();};
  const wrap=(handler,{write=false}={})=>async(req,res)=>{
    if(!dbState.ready)return res.status(503).json({error:'Az adatlapkezelés átmenetileg nem elérhető.',code:'DATABASE_UNAVAILABLE'});
    try{if(write)accounts.protect(req);await handler(req,res);}
    catch(error){const known=error.httpStatus&&error.httpStatus>=400&&error.httpStatus<500;
      if(!known)console.error('[provider-profile]',/^[A-Z0-9_]{2,50}$/.test(error.code||'')?error.code:'PROFILE_ERROR');
      res.status(known?error.httpStatus:503).json({error:known?(error.message===error.code?'Az űrlap lejárt vagy a kérés nem ellenőrizhető. Frissítsd az oldalt.':error.message):'Az adatlap most nem menthető. Próbáld újra később.',code:known?error.code:'PROFILE_UNAVAILABLE'});
    }
  };
  async function tx(fn){const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}}
  function log(action,id,email,details={}){try{Promise.resolve(audit(action,'provider_account',id,email,details)).catch(()=>{});}catch{}}
  async function owned(client,accountId,lock=false) {
    const row=(await client.query(`SELECT l.* FROM provider_listing_owners o JOIN directory_listings l ON l.id=o.listing_id WHERE o.account_id=$1${lock?' FOR UPDATE OF l':''}`,[accountId])).rows[0];
    if(row)row.category_slugs=(await client.query('SELECT c.slug FROM directory_listing_categories lc JOIN directory_categories c ON c.id=lc.category_id WHERE lc.listing_id=$1 ORDER BY c.sort_order,c.id',[row.id])).rows.map(x=>x.slug);
    return row;
  }
  async function response(user) {
    if(!user.is_provider)return {user,has_provider_profile:false,listing:null,categories:[],submission_status:null};
    const [listingResult,categoriesResult,submissionResult]=await Promise.all([
      owned(pool,user.id),pool.query('SELECT slug,name,group_name,verification_level FROM directory_categories WHERE active=true ORDER BY sort_order,id'),
      pool.query('SELECT * FROM directory_submissions WHERE provider_account_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1',[user.id])
    ]);
    let listing=listingResult;const submission=submissionResult.rows[0];
    if(!listing&&submission?.status==='accepted'){
      const active=new Set(categoriesResult.rows.map(x=>x.slug));
      listing={...defaults(),id:null,status:'draft',name:submission.name,email:user.email,phone:submission.phone,website_url:submission.website_url,city:submission.city,online_available:submission.online_available,description:submission.description,qualifications:submission.qualifications,category_slugs:submission.category_slugs.split(',').map(x=>x.trim()).filter(x=>active.has(x)).slice(0,5)};
    }
    return {user,has_provider_profile:true,listing:listingPublic(listing),categories:categoriesResult.rows,submission_status:submission?.status||null};
  }
  function register(app) {
    const profileRoutes=['/api/account/provider-profile','/api/provider/profile'];
    app.get(profileRoutes,privateHeaders,accounts.requireAccount,wrap(async(req,res)=>res.json(await response(req.providerUser))));
    app.post(['/api/account/provider-profile/start','/api/provider/profile/start'],privateHeaders,accounts.requireAccount,wrap(async(req,res)=>{
      const user=await tx(async client=>{
        const account=(await client.query('SELECT * FROM provider_accounts WHERE id=$1 FOR UPDATE',[req.providerUser.id])).rows[0];
        if(!account||account.disabled_at||!account.email_verified_at)throw fail('LOGIN_REQUIRED','Jelentkezz be újra a MENTÁL.hu-fiókodba.',401);
        if(account.provider_profile_started_at)return publicUser(account);
        const updated=(await client.query('UPDATE provider_accounts SET provider_profile_started_at=now(),updated_at=now() WHERE id=$1 RETURNING *',[account.id])).rows[0];
        await client.query("INSERT INTO provider_account_events(account_id,event_type,actor,details) VALUES($1,'provider_profile_started','account','{}')",[account.id]);
        return publicUser(updated);
      });
      log('provider_profile_started',user.id,user.email);
      res.json({...await response(user),message:'A szolgáltatói adatlapodat elindítottuk. Töltsd ki, majd küldd be szerkesztőségi elbírálásra.'});
    },{write:true}));
    app.put(profileRoutes,privateHeaders,accounts.requireAccount,wrap(async(req,res)=>{
      const result=await tx(async client=>{
        const account=(await client.query('SELECT * FROM provider_accounts WHERE id=$1 FOR UPDATE',[req.providerUser.id])).rows[0];
        if(!account||account.disabled_at||!account.email_verified_at)throw fail('LOGIN_REQUIRED','Jelentkezz be újra a MENTÁL.hu-fiókodba.',401);
        if(!account.provider_profile_started_at)throw fail('PROVIDER_PROFILE_REQUIRED','Előbb indítsd el a szolgáltatói adatlapodat a Fiókom oldalon.',403);
        const user=publicUser(account),previous=await owned(client,user.id,true);
        const {values,categories,action}=cleanProfile(req.body,previous,user);
        const categoryRows=(await client.query('SELECT id,slug FROM directory_categories WHERE active=true AND slug=ANY($1::text[])',[categories])).rows;
        if(categoryRows.length!==categories.length)throw fail('CATEGORY_UNAVAILABLE','Egy kiválasztott kategória már nem érhető el. Frissítsd az oldalt.');
        let status=previous?.status||'draft';
        if(action==='publish')status='published';
        if(action==='unpublish')status='draft';
        if(action==='submit')status=user.approved?(status==='published'?'published':'draft'):'pending';
        let id=previous?.id;
        if(!id){
          const slug=(slugify(values.name,{lower:true,strict:true,locale:'hu'}).slice(0,90)||'szolgaltato')+'-'+crypto.randomBytes(6).toString('hex');
          id=(await client.query('INSERT INTO directory_listings(slug,name,email,status) VALUES($1,$2,$3,\'draft\') RETURNING id',[slug,values.name,user.email])).rows[0].id;
          await client.query('INSERT INTO provider_listing_owners(account_id,listing_id) VALUES($1,$2)',[user.id,id]);
        }
        const params=FIELDS.map(key=>values[key]);params.push(status,id);
        await client.query(`UPDATE directory_listings SET ${FIELDS.map((key,i)=>key+'=$'+(i+1)).join(',')},status=$${FIELDS.length+1},published_at=CASE WHEN $${FIELDS.length+1}='published' THEN COALESCE(published_at,now()) ELSE NULL END,updated_at=now() WHERE id=$${FIELDS.length+2}`,params);
        await client.query('DELETE FROM directory_listing_categories WHERE listing_id=$1',[id]);
        if(categoryRows.length)await client.query('INSERT INTO directory_listing_categories(listing_id,category_id) SELECT $1,unnest($2::bigint[])',[id,categoryRows.map(x=>x.id)]);
        if(action==='submit'&&!user.approved){
          const old=(await client.query("SELECT id FROM directory_submissions WHERE provider_account_id=$1 AND deleted_at IS NULL AND status<>'accepted' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",[user.id])).rows[0];
          const fields=[values.name,user.display_name,user.email,values.phone,values.website_url,categories.join(','),values.city,values.online_available,values.description,values.qualifications,user.id];
          if(old)await client.query("UPDATE directory_submissions SET name=$1,contact_name=$2,email=$3,phone=$4,website_url=$5,category_slugs=$6,city=$7,online_available=$8,description=$9,qualifications=$10,provider_account_id=$11,consent=true,status='new',updated_at=now() WHERE id=$12",[...fields,old.id]);
          else await client.query("INSERT INTO directory_submissions(name,contact_name,email,phone,website_url,category_slugs,city,online_available,description,qualifications,provider_account_id,consent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)",fields);
        }
        await client.query('INSERT INTO provider_account_events(account_id,event_type,actor,details) VALUES($1,$2,$3,$4)',[user.id,'profile_'+action,'provider',{listing_id:id,status}]);
        return {user,id,action,status};
      });
      log('profile_'+result.action,result.user.id,result.user.email,{listing_id:result.id,status:result.status});
      const message=result.action==='publish'?'Az adatlapod megjelent a katalógusban.':result.action==='unpublish'?'Az adatlapod már nem nyilvános. A szerkesztett adataidat megőriztük.':result.action==='submit'&&!result.user.approved?'A jelentkezésedet beküldted elbírálásra. Az eredményről e-mailben értesítünk.':'Az adatlapodat elmentettük.';
      res.json({...await response(result.user),message});
    },{write:true}));

    app.get('/api/admin/provider-accounts',privateHeaders,auth,wrap(async(req,res)=>{
      const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,200):'';
      const page=Math.max(1,Math.min(1000000,parseInt(req.query.page,10)||1)),pageSize=Math.max(1,Math.min(100,parseInt(req.query.page_size,10)||25));
      const params=[],where=q?'WHERE a.email ILIKE $1 OR a.display_name ILIKE $1':'';if(q)params.push('%'+q.replace(/[\\%_]/g,'\\$&')+'%');
      const total=(await pool.query('SELECT count(*)::int AS n FROM provider_accounts a '+where,params)).rows[0].n;
      const rows=(await pool.query(`SELECT a.id,a.email,a.display_name,a.approved_at IS NOT NULL AS approved,a.disabled_at IS NOT NULL AS disabled,a.email_verified_at IS NOT NULL AS email_verified,a.provider_profile_started_at IS NOT NULL AS is_provider,a.created_at,l.id AS listing_id,l.name AS listing_name,l.status AS listing_status,l.slug AS listing_slug FROM provider_accounts a LEFT JOIN provider_listing_owners o ON o.account_id=a.id LEFT JOIN directory_listings l ON l.id=o.listing_id ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,pageSize,(page-1)*pageSize])).rows;
      const items=rows.map(({listing_id,listing_name,listing_status,listing_slug,...a})=>({...a,has_provider_profile:a.is_provider,listing:listing_id?{id:listing_id,name:listing_name,status:listing_status,url:'/szolgaltato/'+encodeURIComponent(listing_slug)}:null}));
      res.json({items,total,page,pages:Math.max(1,Math.ceil(total/pageSize)),page_size:pageSize});
    }));
    app.post('/api/admin/provider-accounts/:id/action',privateHeaders,auth,wrap(async(req,res)=>{
      const id=req.params.id,action=req.body.action;
      if(!/^[1-9]\d{0,18}$/.test(id)||BigInt(id)>9223372036854775807n||!['disable','enable'].includes(action))throw fail('INVALID_ACTION','Érvénytelen fiókművelet.');
      await tx(async client=>{
        const account=(await client.query('SELECT id FROM provider_accounts WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!account)throw fail('NOT_FOUND','A fiók nem található.',404);
        await client.query('UPDATE provider_accounts SET disabled_at=CASE WHEN $2 THEN COALESCE(disabled_at,now()) ELSE NULL END,updated_at=now() WHERE id=$1',[id,action==='disable']);
        if(action==='disable'){
          await client.query('DELETE FROM provider_account_sessions WHERE account_id=$1',[id]);
          await client.query("UPDATE directory_listings SET status='draft',published_at=NULL,updated_at=now() WHERE id IN (SELECT listing_id FROM provider_listing_owners WHERE account_id=$1) AND status='published'",[id]);
        }
        await client.query('INSERT INTO provider_account_events(account_id,event_type,actor,details) VALUES($1,$2,$3,$4)',[id,'account_'+action,'admin',{}]);
      });
      log(action,id,req.user.email);res.json({ok:true,message:action==='disable'?'A fiókot felfüggesztettük, az adatlapot elrejtettük.':'A fiókot újra engedélyeztük. Az adatlapot a szolgáltató teheti közzé.'});
    },{write:true}));
  }
  return {register};
}

module.exports={createProviderProfileService,cleanProfile,listingPublic,LIMITS,FIELDS};
